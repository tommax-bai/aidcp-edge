use crate::error::{EngineError, ErrorCode};
use crate::protocol::Platform;
use serde::Deserialize;
use std::net::IpAddr;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use url::Url;

const MAX_HTTP_RESPONSE_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CdpTarget {
    pub id: String,
    #[serde(rename = "type")]
    pub target_type: String,
    pub url: String,
    #[serde(default)]
    pub web_socket_debugger_url: String,
}

pub fn validate_loopback_host(host: &str) -> Result<(), EngineError> {
    let normalized = host.trim().to_ascii_lowercase();
    if normalized == "localhost"
        || normalized
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
    {
        return Ok(());
    }
    Err(EngineError::new(
        ErrorCode::EndpointNotLoopback,
        "DevTools endpoint must be loopback",
    ))
}

pub async fn list_targets(host: &str, port: u16) -> Result<Vec<CdpTarget>, EngineError> {
    validate_loopback_host(host)?;
    let mut stream = TcpStream::connect((host, port)).await.map_err(|_| {
        EngineError::new(
            ErrorCode::EndpointUnreachable,
            "DevTools endpoint is unreachable",
        )
    })?;
    let host_header = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let request = format!(
        "GET /json HTTP/1.1\r\nHost: {host_header}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await.map_err(|_| {
        EngineError::new(
            ErrorCode::EndpointUnreachable,
            "DevTools endpoint request failed",
        )
    })?;

    let mut response = Vec::new();
    let mut chunk = [0_u8; 8 * 1024];
    loop {
        let read = stream.read(&mut chunk).await.map_err(|_| {
            EngineError::new(
                ErrorCode::EndpointUnreachable,
                "DevTools endpoint response failed",
            )
        })?;
        if read == 0 {
            break;
        }
        response.extend_from_slice(&chunk[..read]);
        if response.len() as u64 > MAX_HTTP_RESPONSE_BYTES {
            return Err(EngineError::new(
                ErrorCode::EndpointUnreachable,
                "DevTools endpoint response exceeds limit",
            ));
        }
        if response_is_complete(&response) {
            break;
        }
    }
    parse_target_response(&response)
}

fn response_is_complete(response: &[u8]) -> bool {
    let Some(separator) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
        return false;
    };
    let Ok(headers) = std::str::from_utf8(&response[..separator]) else {
        return false;
    };
    let body = &response[separator + 4..];
    if let Some(length) = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    }) {
        return body.len() >= length;
    }
    if headers.lines().any(|line| {
        line.to_ascii_lowercase()
            .starts_with("transfer-encoding: chunked")
    }) {
        return chunked_body_complete(body);
    }
    false
}

fn chunked_body_complete(body: &[u8]) -> bool {
    let mut cursor = 0;
    loop {
        let Some(line_position) = body[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")
        else {
            return false;
        };
        let line_end = cursor + line_position;
        let Ok(size_text) = std::str::from_utf8(&body[cursor..line_end]) else {
            return false;
        };
        let Some(size_text) = size_text.split(';').next() else {
            return false;
        };
        let Ok(size) = usize::from_str_radix(size_text.trim(), 16) else {
            return false;
        };
        cursor = line_end + 2;
        if size == 0 {
            return cursor + 2 <= body.len() && &body[cursor..cursor + 2] == b"\r\n";
        }
        let Some(end) = cursor.checked_add(size).filter(|end| end + 2 <= body.len()) else {
            return false;
        };
        if &body[end..end + 2] != b"\r\n" {
            return false;
        }
        cursor = end + 2;
    }
}

fn parse_target_response(response: &[u8]) -> Result<Vec<CdpTarget>, EngineError> {
    let separator = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(invalid_endpoint_response)?;
    let headers =
        std::str::from_utf8(&response[..separator]).map_err(|_| invalid_endpoint_response())?;
    let status = headers
        .lines()
        .next()
        .ok_or_else(invalid_endpoint_response)?;
    if !(status.starts_with("HTTP/1.1 200 ") || status.starts_with("HTTP/1.0 200 ")) {
        return Err(invalid_endpoint_response());
    }
    let body = &response[separator + 4..];
    let decoded;
    let body = if headers.lines().any(|line| {
        line.to_ascii_lowercase()
            .starts_with("transfer-encoding: chunked")
    }) {
        decoded = decode_chunked(body)?;
        decoded.as_slice()
    } else {
        body
    };
    serde_json::from_slice(body).map_err(|_| invalid_endpoint_response())
}

fn decode_chunked(body: &[u8]) -> Result<Vec<u8>, EngineError> {
    let mut cursor = 0;
    let mut decoded = Vec::new();
    loop {
        let line_end = body[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")
            .map(|position| cursor + position)
            .ok_or_else(invalid_endpoint_response)?;
        let size_text = std::str::from_utf8(&body[cursor..line_end])
            .map_err(|_| invalid_endpoint_response())?
            .split(';')
            .next()
            .ok_or_else(invalid_endpoint_response)?;
        let size =
            usize::from_str_radix(size_text.trim(), 16).map_err(|_| invalid_endpoint_response())?;
        cursor = line_end + 2;
        if size == 0 {
            if cursor + 2 > body.len() || &body[cursor..cursor + 2] != b"\r\n" {
                return Err(invalid_endpoint_response());
            }
            return Ok(decoded);
        }
        let end = cursor
            .checked_add(size)
            .filter(|end| end + 2 <= body.len())
            .ok_or_else(invalid_endpoint_response)?;
        decoded.extend_from_slice(&body[cursor..end]);
        if &body[end..end + 2] != b"\r\n" {
            return Err(invalid_endpoint_response());
        }
        cursor = end + 2;
    }
}

fn invalid_endpoint_response() -> EngineError {
    EngineError::new(
        ErrorCode::EndpointUnreachable,
        "DevTools endpoint returned an invalid response",
    )
}

pub fn select_target(
    targets: &[CdpTarget],
    platform: Platform,
    endpoint_port: u16,
) -> Result<CdpTarget, EngineError> {
    let matched = targets
        .iter()
        .find(|target| {
            target.target_type == "page"
                && is_allowed_page_url(&target.url, platform)
                && is_allowed_debugger_url(&target.web_socket_debugger_url, endpoint_port)
        })
        .cloned();
    if let Some(target) = matched {
        return Ok(target);
    }
    if platform == Platform::Facebook {
        let mut blank = targets.iter().filter(|target| {
            target.target_type == "page"
                && target.url == "about:blank"
                && is_allowed_debugger_url(&target.web_socket_debugger_url, endpoint_port)
        });
        if let Some(target) = blank.next()
            && blank.next().is_none()
        {
            return Ok(target.clone());
        }
    }
    Err(EngineError::new(
        ErrorCode::NoMatchingTarget,
        "no matching page target was found",
    ))
}

fn is_allowed_page_url(raw_url: &str, platform: Platform) -> bool {
    let Ok(url) = Url::parse(raw_url) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    match platform {
        Platform::Xiaohongshu => host == "xiaohongshu.com" || host.ends_with(".xiaohongshu.com"),
        Platform::Facebook => {
            host == "facebook.com"
                || host.ends_with(".facebook.com")
                || host == "facebookcorewwwi.onion"
        }
        Platform::WechatChannels => host == "channels.weixin.qq.com",
    }
}

fn is_allowed_debugger_url(raw_url: &str, endpoint_port: u16) -> bool {
    let Ok(url) = Url::parse(raw_url) else {
        return false;
    };
    if url.scheme() != "ws" || url.port() != Some(endpoint_port) {
        return false;
    }
    url.host_str()
        .and_then(|host| host.parse::<IpAddr>().ok())
        .is_some_and(|address| address.is_loopback())
        || url.host_str() == Some("localhost")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::net::TcpListener;

    fn target(id: &str, target_type: &str, url: &str, websocket: &str) -> CdpTarget {
        CdpTarget {
            id: id.to_owned(),
            target_type: target_type.to_owned(),
            url: url.to_owned(),
            web_socket_debugger_url: websocket.to_owned(),
        }
    }

    #[test]
    fn accepts_only_loopback_hosts() {
        assert!(validate_loopback_host("127.0.0.1").is_ok());
        assert!(validate_loopback_host("::1").is_ok());
        assert!(validate_loopback_host("localhost").is_ok());
        assert_eq!(
            validate_loopback_host("192.0.2.10")
                .expect_err("remote endpoint")
                .code,
            ErrorCode::EndpointNotLoopback
        );
    }

    #[test]
    fn selects_only_allowed_xiaohongshu_page() {
        let targets = vec![
            target(
                "unrelated",
                "page",
                "https://example.com/",
                "ws://127.0.0.1:9222/devtools/page/unrelated",
            ),
            target(
                "worker",
                "service_worker",
                "https://www.xiaohongshu.com/explore",
                "ws://127.0.0.1:9222/devtools/page/worker",
            ),
            target(
                "xhs",
                "page",
                "https://www.xiaohongshu.com/explore",
                "ws://127.0.0.1:9222/devtools/page/xhs",
            ),
        ];
        let selected = select_target(&targets, Platform::Xiaohongshu, 9222).expect("target");
        assert_eq!(selected.id, "xhs");
    }

    #[test]
    fn selects_only_the_bound_platform_target() {
        let targets = vec![
            target(
                "xhs",
                "page",
                "https://www.xiaohongshu.com/explore",
                "ws://127.0.0.1:9222/devtools/page/xhs",
            ),
            target(
                "facebook",
                "page",
                "https://www.facebook.com/",
                "ws://127.0.0.1:9222/devtools/page/facebook",
            ),
            target(
                "wechat",
                "page",
                "https://channels.weixin.qq.com/platform/post/list",
                "ws://127.0.0.1:9222/devtools/page/wechat",
            ),
        ];
        assert_eq!(
            select_target(&targets, Platform::Facebook, 9222)
                .expect("facebook")
                .id,
            "facebook"
        );
        assert_eq!(
            select_target(&targets, Platform::WechatChannels, 9222)
                .expect("wechat")
                .id,
            "wechat"
        );
    }

    #[test]
    fn facebook_accepts_one_exact_blank_bootstrap_target_only() {
        let blank = target(
            "blank",
            "page",
            "about:blank",
            "ws://127.0.0.1:9222/devtools/page/blank",
        );
        assert_eq!(
            select_target(std::slice::from_ref(&blank), Platform::Facebook, 9222)
                .expect("single blank bootstrap")
                .id,
            "blank",
        );
        assert!(
            select_target(
                &[
                    blank,
                    target(
                        "blank-2",
                        "page",
                        "about:blank",
                        "ws://127.0.0.1:9222/devtools/page/blank-2",
                    ),
                ],
                Platform::Facebook,
                9222,
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_lookalike_platform_hosts() {
        for (platform, url) in [
            (Platform::Facebook, "https://www.facebook.com.evil.test/"),
            (
                Platform::WechatChannels,
                "https://channels.weixin.qq.com.evil.test/platform/post/list",
            ),
        ] {
            let targets = vec![target(
                "lookalike",
                "page",
                url,
                "ws://127.0.0.1:9222/devtools/page/lookalike",
            )];
            assert_eq!(
                select_target(&targets, platform, 9222)
                    .expect_err("lookalike host")
                    .code,
                ErrorCode::NoMatchingTarget
            );
        }
    }

    #[test]
    fn rejects_remote_or_wrong_port_debugger_url() {
        for websocket in [
            "ws://192.0.2.10:9222/devtools/page/xhs",
            "ws://127.0.0.1:9333/devtools/page/xhs",
        ] {
            let targets = vec![target(
                "xhs",
                "page",
                "https://www.xiaohongshu.com/explore",
                websocket,
            )];
            assert_eq!(
                select_target(&targets, Platform::Xiaohongshu, 9222)
                    .expect_err("unsafe debugger URL")
                    .code,
                ErrorCode::NoMatchingTarget
            );
        }
    }

    #[test]
    fn parses_fixed_and_chunked_target_responses() {
        let json = br#"[{"id":"xhs","type":"page","url":"https://www.xiaohongshu.com/explore","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/page/xhs"}]"#;
        let fixed = [
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n".as_slice(),
            json,
        ]
        .concat();
        assert_eq!(parse_target_response(&fixed).expect("fixed").len(), 1);

        let chunked = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
            json.len(),
            std::str::from_utf8(json).expect("json")
        );
        assert_eq!(
            parse_target_response(chunked.as_bytes())
                .expect("chunked")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn content_length_response_does_not_wait_for_keep_alive_close() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await.expect("request");
            let body = br#"[{"id":"xhs","type":"page","url":"https://www.xiaohongshu.com/explore","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/page/xhs"}]"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n",
                body.len()
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("headers");
            socket.write_all(body).await.expect("body");
            tokio::time::sleep(Duration::from_secs(1)).await;
        });
        let targets =
            tokio::time::timeout(Duration::from_millis(200), list_targets("127.0.0.1", port))
                .await
                .expect("must not wait for close")
                .expect("targets");
        assert_eq!(targets.len(), 1);
        server.abort();
    }
}
