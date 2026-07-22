use aidcp_page_engine::execute_probe;
use aidcp_page_engine::protocol::{ReadyRecord, ResponseRecord, parse_request, recover_request_id};
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[tokio::main]
async fn main() {
    let mut stdout = tokio::io::stdout();
    if write_record(&mut stdout, &ReadyRecord::default())
        .await
        .is_err()
    {
        return;
    }
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(_) => {
                eprintln!("native_page_engine_stdin_failed");
                break;
            }
        };
        let request = match parse_request(&line) {
            Ok(request) => request,
            Err(error) => {
                let id = recover_request_id(&line);
                eprintln!("native_page_engine_request_rejected:{:?}", error.code);
                let response = ResponseRecord::<serde_json::Value>::failure(&id, error);
                if write_record(&mut stdout, &response).await.is_err() {
                    break;
                }
                continue;
            }
        };
        match execute_probe(&request.params).await {
            Ok(result) => {
                let response = ResponseRecord::success(&request.id, &result);
                if write_record(&mut stdout, &response).await.is_err() {
                    break;
                }
            }
            Err(error) => {
                eprintln!("native_page_engine_probe_failed:{:?}", error.code);
                let response = ResponseRecord::<serde_json::Value>::failure(&request.id, error);
                if write_record(&mut stdout, &response).await.is_err() {
                    break;
                }
            }
        }
    }
}

async fn write_record<T: Serialize>(
    stdout: &mut tokio::io::Stdout,
    record: &T,
) -> Result<(), std::io::Error> {
    let line = serde_json::to_vec(record).map_err(std::io::Error::other)?;
    stdout.write_all(&line).await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await
}
