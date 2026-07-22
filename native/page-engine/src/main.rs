use aidcp_page_engine::engine::{CancelResult, CommandOutput, Engine, StoredCommandResult};
use aidcp_page_engine::error::{EngineError, ErrorCode};
use aidcp_page_engine::protocol::{
    CommandRecord, CommandResultRecord, EffectPhase, InputRecord, LifecycleResponse,
    MAX_RECORD_BYTES, ReadyRecord, parse_input, recover_request_id,
};
use serde::Serialize;
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::task::JoinHandle;

struct ActiveCommand {
    request: CommandRecord,
    cancellation: Arc<AtomicBool>,
    handle: JoinHandle<(Engine, Result<StoredCommandResult, EngineError>)>,
}

type CommandCompletion =
    Result<(Engine, Result<StoredCommandResult, EngineError>), tokio::task::JoinError>;

enum ActiveEvent {
    Completed(Box<CommandCompletion>),
    Input(Result<Option<String>, std::io::Error>),
}

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
    let mut engine = Some(Engine::default());
    let mut active: Option<ActiveCommand> = None;
    let mut input_closed = false;

    loop {
        if active.is_none() {
            if input_closed {
                break;
            }
            let line = match read_line(&mut lines).await {
                Some(line) => line,
                None => {
                    input_closed = true;
                    continue;
                }
            };
            let Some(record) = parse_or_respond(&line, &mut stdout).await else {
                continue;
            };
            if let InputRecord::Command(request) = record {
                let cancellation = Arc::new(AtomicBool::new(false));
                let cancellation_for_task = cancellation.clone();
                let request_for_task = request.clone();
                let mut owned_engine = engine.take().expect("idle engine must be present");
                let handle = tokio::spawn(async move {
                    let outcome = owned_engine
                        .execute_cancellable(&request_for_task, cancellation_for_task)
                        .await;
                    (owned_engine, outcome)
                });
                active = Some(ActiveCommand {
                    request,
                    cancellation,
                    handle,
                });
                continue;
            }
            let should_stop =
                handle_idle_record(record, engine.as_mut().expect("idle engine"), &mut stdout)
                    .await;
            if should_stop {
                break;
            }
            continue;
        }

        let event = {
            let active_command = active.as_mut().expect("active command");
            tokio::select! {
                completed = &mut active_command.handle => ActiveEvent::Completed(Box::new(completed)),
                input = lines.next_line() => ActiveEvent::Input(input),
            }
        };

        match event {
            ActiveEvent::Completed(completed) => {
                let finished = active.take().expect("active command");
                match *completed {
                    Ok((returned_engine, outcome)) => {
                        engine = Some(returned_engine);
                        if write_command_outcome(&mut stdout, &finished.request, outcome)
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(_) => {
                        let error = EngineError::new(
                            ErrorCode::EngineInternal,
                            "native page engine command worker failed",
                        );
                        let response = CommandResultRecord::<CommandOutput>::failure(
                            &finished.request,
                            EffectPhase::Ambiguous,
                            error,
                        );
                        let _ = write_record(&mut stdout, &response).await;
                        break;
                    }
                }
                if input_closed {
                    break;
                }
            }
            ActiveEvent::Input(Ok(Some(line))) => {
                let Some(record) = parse_or_respond(&line, &mut stdout).await else {
                    continue;
                };
                let active_command = active.as_ref().expect("active command");
                match record {
                    InputRecord::Cancel(request) => {
                        let outcome = if request.session_id != active_command.request.session_id {
                            Err(EngineError::new(
                                ErrorCode::SessionMismatch,
                                "native page engine session identity does not match",
                            ))
                        } else if request.task_id != active_command.request.task_id {
                            Err(EngineError::new(
                                ErrorCode::TaskMismatch,
                                "native page engine task identity does not own the session",
                            ))
                        } else if request.command_id != active_command.request.command_id {
                            Err(EngineError::new(
                                ErrorCode::DuplicateCommand,
                                "native page engine cancellation command identity does not match",
                            ))
                        } else {
                            active_command.cancellation.store(true, Ordering::Release);
                            Ok(CancelResult {
                                accepted: true,
                                state: "cancellation_requested",
                                command_id: request.command_id,
                            })
                        };
                        match outcome {
                            Ok(result) => {
                                let response = LifecycleResponse::success(&request.id, &result);
                                if write_record(&mut stdout, &response).await.is_err() {
                                    break;
                                }
                            }
                            Err(error) => {
                                let response = LifecycleResponse::<serde_json::Value>::failure(
                                    &request.id,
                                    error,
                                );
                                if write_record(&mut stdout, &response).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    InputRecord::Command(request) => {
                        let response = CommandResultRecord::<CommandOutput>::failure(
                            &request,
                            EffectPhase::NotStarted,
                            EngineError::new(
                                ErrorCode::CommandInProgress,
                                "native page engine already has an active command",
                            ),
                        );
                        if write_record(&mut stdout, &response).await.is_err() {
                            break;
                        }
                    }
                    other => {
                        let response = LifecycleResponse::<serde_json::Value>::failure(
                            other.id(),
                            EngineError::new(
                                ErrorCode::CommandInProgress,
                                "native page engine lifecycle request blocked by active command",
                            ),
                        );
                        if write_record(&mut stdout, &response).await.is_err() {
                            break;
                        }
                    }
                }
            }
            ActiveEvent::Input(Ok(None)) | ActiveEvent::Input(Err(_)) => {
                input_closed = true;
                if let Some(active_command) = &active {
                    active_command.cancellation.store(true, Ordering::Release);
                }
            }
        }
    }

    if let Some(active_command) = active {
        active_command.cancellation.store(true, Ordering::Release);
        let _ = active_command.handle.await;
    }
    if let Some(mut engine) = engine {
        engine.shutdown().await;
    }
}

async fn handle_idle_record(
    record: InputRecord,
    engine: &mut Engine,
    stdout: &mut tokio::io::Stdout,
) -> bool {
    let write_result = match record {
        InputRecord::SessionOpen(request) => match engine.open(&request).await {
            Ok(result) => {
                write_record(stdout, &LifecycleResponse::success(&request.id, &result)).await
            }
            Err(error) => {
                eprintln!("native_page_engine_session_open_failed:{:?}", error.code);
                write_record(
                    stdout,
                    &LifecycleResponse::<serde_json::Value>::failure(&request.id, error),
                )
                .await
            }
        },
        InputRecord::SessionStatus(request) => match engine.status(&request) {
            Ok(result) => {
                write_record(stdout, &LifecycleResponse::success(&request.id, &result)).await
            }
            Err(error) => {
                write_record(
                    stdout,
                    &LifecycleResponse::<serde_json::Value>::failure(&request.id, error),
                )
                .await
            }
        },
        InputRecord::SessionClose(request) => match engine.close(&request).await {
            Ok(result) => {
                write_record(stdout, &LifecycleResponse::success(&request.id, &result)).await
            }
            Err(error) => {
                write_record(
                    stdout,
                    &LifecycleResponse::<serde_json::Value>::failure(&request.id, error),
                )
                .await
            }
        },
        InputRecord::Cancel(request) => match engine.cancel(&request) {
            Ok(result) => {
                write_record(stdout, &LifecycleResponse::success(&request.id, &result)).await
            }
            Err(error) => {
                write_record(
                    stdout,
                    &LifecycleResponse::<serde_json::Value>::failure(&request.id, error),
                )
                .await
            }
        },
        InputRecord::Shutdown(request) => {
            engine.shutdown().await;
            let result = json!({ "state": "shutting_down" });
            let _ = write_record(stdout, &LifecycleResponse::success(&request.id, &result)).await;
            return true;
        }
        InputRecord::Command(_) => unreachable!("commands are started by the caller"),
    };
    write_result.is_err()
}

async fn write_command_outcome(
    stdout: &mut tokio::io::Stdout,
    request: &CommandRecord,
    outcome: Result<StoredCommandResult, EngineError>,
) -> Result<(), std::io::Error> {
    match outcome {
        Ok(outcome) => match (&outcome.output, &outcome.error) {
            (Some(output), None) => {
                write_record(
                    stdout,
                    &CommandResultRecord::success(request, outcome.effect_phase, output),
                )
                .await
            }
            (_, Some(error)) => {
                write_record(
                    stdout,
                    &CommandResultRecord::<CommandOutput>::failure(
                        request,
                        outcome.effect_phase,
                        error.clone(),
                    ),
                )
                .await
            }
            _ => {
                write_record(
                    stdout,
                    &CommandResultRecord::<CommandOutput>::failure(
                        request,
                        EffectPhase::Ambiguous,
                        EngineError::new(
                            ErrorCode::EngineInternal,
                            "native page engine produced an invalid terminal state",
                        ),
                    ),
                )
                .await
            }
        },
        Err(error) => {
            write_record(
                stdout,
                &CommandResultRecord::<CommandOutput>::failure(
                    request,
                    EffectPhase::NotStarted,
                    error,
                ),
            )
            .await
        }
    }
}

async fn parse_or_respond(line: &str, stdout: &mut tokio::io::Stdout) -> Option<InputRecord> {
    match parse_input(line) {
        Ok(record) => Some(record),
        Err(error) => {
            let id = recover_request_id(line);
            eprintln!("native_page_engine_request_rejected:{:?}", error.code);
            let response = LifecycleResponse::<serde_json::Value>::failure(&id, error);
            let _ = write_record(stdout, &response).await;
            None
        }
    }
}

async fn read_line(lines: &mut Lines<BufReader<tokio::io::Stdin>>) -> Option<String> {
    match lines.next_line().await {
        Ok(line) => line,
        Err(_) => {
            eprintln!("native_page_engine_stdin_failed");
            None
        }
    }
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
