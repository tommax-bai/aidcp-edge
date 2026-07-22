use aidcp_page_engine::engine::{CommandOutput, Engine};
use aidcp_page_engine::protocol::{
    CommandResultRecord, EffectPhase, InputRecord, LifecycleResponse, MAX_RECORD_BYTES,
    ReadyRecord, parse_input, recover_request_id,
};
use serde::Serialize;
use serde_json::json;
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
    let mut engine = Engine::default();
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
        let record = match parse_input(&line) {
            Ok(record) => record,
            Err(error) => {
                let id = recover_request_id(&line);
                eprintln!("native_page_engine_request_rejected:{:?}", error.code);
                let response = LifecycleResponse::<serde_json::Value>::failure(&id, error);
                if write_record(&mut stdout, &response).await.is_err() {
                    break;
                }
                continue;
            }
        };

        let should_shutdown = matches!(record, InputRecord::Shutdown(_));
        let write_result = match &record {
            InputRecord::SessionOpen(request) => match engine.open(request).await {
                Ok(result) => {
                    write_record(
                        &mut stdout,
                        &LifecycleResponse::success(&request.id, &result),
                    )
                    .await
                }
                Err(error) => {
                    eprintln!("native_page_engine_session_open_failed:{:?}", error.code);
                    write_record(
                        &mut stdout,
                        &LifecycleResponse::<serde_json::Value>::failure(&request.id, error),
                    )
                    .await
                }
            },
            InputRecord::SessionStatus(request) => match engine.status(request) {
                Ok(result) => {
                    write_record(
                        &mut stdout,
                        &LifecycleResponse::success(&request.id, &result),
                    )
                    .await
                }
                Err(error) => {
                    write_record(
                        &mut stdout,
                        &LifecycleResponse::<serde_json::Value>::failure(&request.id, error),
                    )
                    .await
                }
            },
            InputRecord::SessionClose(request) => match engine.close(request).await {
                Ok(result) => {
                    write_record(
                        &mut stdout,
                        &LifecycleResponse::success(&request.id, &result),
                    )
                    .await
                }
                Err(error) => {
                    write_record(
                        &mut stdout,
                        &LifecycleResponse::<serde_json::Value>::failure(&request.id, error),
                    )
                    .await
                }
            },
            InputRecord::Command(request) => match engine.execute(request).await {
                Ok(outcome) => match (&outcome.output, &outcome.error) {
                    (Some(output), None) => {
                        let response =
                            CommandResultRecord::success(request, outcome.effect_phase, output);
                        write_record(&mut stdout, &response).await
                    }
                    (_, Some(error)) => {
                        let response = CommandResultRecord::<CommandOutput>::failure(
                            request,
                            outcome.effect_phase,
                            error.clone(),
                        );
                        write_record(&mut stdout, &response).await
                    }
                    _ => {
                        let response = CommandResultRecord::<CommandOutput>::failure(
                            request,
                            EffectPhase::Ambiguous,
                            aidcp_page_engine::error::EngineError::new(
                                aidcp_page_engine::error::ErrorCode::EngineInternal,
                                "native page engine produced an invalid terminal state",
                            ),
                        );
                        write_record(&mut stdout, &response).await
                    }
                },
                Err(error) => {
                    let response = CommandResultRecord::<CommandOutput>::failure(
                        request,
                        EffectPhase::NotStarted,
                        error,
                    );
                    write_record(&mut stdout, &response).await
                }
            },
            InputRecord::Cancel(request) => match engine.cancel(request) {
                Ok(result) => {
                    write_record(
                        &mut stdout,
                        &LifecycleResponse::success(&request.id, &result),
                    )
                    .await
                }
                Err(error) => {
                    write_record(
                        &mut stdout,
                        &LifecycleResponse::<serde_json::Value>::failure(&request.id, error),
                    )
                    .await
                }
            },
            InputRecord::Shutdown(request) => {
                engine.shutdown().await;
                let result = json!({ "state": "shutting_down" });
                write_record(
                    &mut stdout,
                    &LifecycleResponse::success(&request.id, &result),
                )
                .await
            }
        };
        if write_result.is_err() {
            break;
        }
        if should_shutdown {
            break;
        }
    }
    engine.shutdown().await;
}

async fn write_record<T: Serialize>(
    stdout: &mut tokio::io::Stdout,
    record: &T,
) -> Result<(), std::io::Error> {
    let line = serde_json::to_vec(record).map_err(std::io::Error::other)?;
    if line.len() > MAX_RECORD_BYTES {
        return Err(std::io::Error::other(
            "native page engine response exceeds protocol limit",
        ));
    }
    stdout.write_all(&line).await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await
}
