//! A machine's media over the remote server (improvement plan S3): the files its
//! sessions showed with `show_media`, by id, for another machine's strip and for the
//! phone. Registered files only, as on this machine's own `wbmedia` scheme, with
//! `Range`. The relay takes `/api/media` to the machine the phone shows.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use tauri::Manager;

use super::server::{authed, bearer, client_addr};
use super::RemoteState;
use crate::db::Db;

/// `GET /api/media/<id>`: the file, whole or the range asked for.
pub(super) async fn file(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(refusal) = authed(&state, bearer(&headers).as_deref(), &client_addr(peer, &headers)) {
        return refusal;
    }
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_string);
    let app = state.app.clone();
    let answer = tauri::async_runtime::spawn_blocking(move || crate::media::serve::registered(&app, &id, range.as_deref()))
        .await;
    let Ok(answer) = answer else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let mut out = Response::builder().status(answer.status.as_u16());
    for (k, v) in answer.headers {
        out = out.header(k.as_str(), v);
    }
    out.body(Body::from(answer.body)).unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// `GET /api/media/<id>/info`: what it is, its size and whether it's still there,
/// without the path.
pub(super) async fn info(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(refusal) = authed(&state, bearer(&headers).as_deref(), &client_addr(peer, &headers)) {
        return refusal;
    }
    let found = {
        let db = state.app.state::<Db>();
        let Ok(conn) = db.conn.lock() else {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        };
        crate::media::lookup(&conn, &id)
    };
    match found {
        Some(mut info) => {
            info.path = String::new();
            Json(info).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
