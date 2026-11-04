//! Project notes in the office (the bookshelves): the phone's notes API
//! (`remote/notes.rs`) on the office's listener, signed in with the office's session
//! rather than a pairing. Same requests, same answers, same `notes::notify` on every
//! change, so the desktop panel and any phone hear an edit made here.
//!
//! - `GET  /office/api/notes`, `GET /office/api/notes/list?project=`,
//!   `GET /office/api/notes/read?project=&id=`
//! - `POST /office/api/notes/create|save|rename|delete` — bodies as the phone's.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::super::notes::{self as phone, CreateReq, DeleteReq, ProjectQuery, RenameReq, SaveReq};
use super::super::server::bearer;
use super::super::RemoteState;

#[allow(clippy::result_large_err)] // a refusal is built once per refused request
/// The office's session, then the notes root and a known project.
fn gate(state: &Arc<RemoteState>, headers: &HeaderMap, project: Option<&str>) -> Result<std::path::PathBuf, Response> {
    if !state.office.valid(bearer(headers).as_deref()) {
        return Err(StatusCode::UNAUTHORIZED.into_response());
    }
    phone::root_for(state, project)
}

pub(super) async fn counts(State(state): State<Arc<RemoteState>>, headers: HeaderMap) -> Response {
    match gate(&state, &headers, None) {
        Ok(root) => phone::do_counts(&state, &root),
        Err(refusal) => refusal,
    }
}

pub(super) async fn list(State(state): State<Arc<RemoteState>>, headers: HeaderMap, Query(q): Query<ProjectQuery>) -> Response {
    match gate(&state, &headers, Some(&q.project)) {
        Ok(root) => phone::do_list(&state, &root, q),
        Err(refusal) => refusal,
    }
}

pub(super) async fn read(State(state): State<Arc<RemoteState>>, headers: HeaderMap, Query(q): Query<ProjectQuery>) -> Response {
    match gate(&state, &headers, Some(&q.project)) {
        Ok(root) => phone::do_read(&state, &root, q),
        Err(refusal) => refusal,
    }
}

pub(super) async fn create(State(state): State<Arc<RemoteState>>, headers: HeaderMap, Json(req): Json<CreateReq>) -> Response {
    match gate(&state, &headers, Some(&req.project)) {
        Ok(root) => phone::do_create(&state, &root, req),
        Err(refusal) => refusal,
    }
}

pub(super) async fn save(State(state): State<Arc<RemoteState>>, headers: HeaderMap, Json(req): Json<SaveReq>) -> Response {
    match gate(&state, &headers, Some(&req.project)) {
        Ok(root) => phone::do_save(&state, &root, req),
        Err(refusal) => refusal,
    }
}

pub(super) async fn rename(State(state): State<Arc<RemoteState>>, headers: HeaderMap, Json(req): Json<RenameReq>) -> Response {
    match gate(&state, &headers, Some(&req.project)) {
        Ok(root) => phone::do_rename(&state, &root, req),
        Err(refusal) => refusal,
    }
}

pub(super) async fn delete(State(state): State<Arc<RemoteState>>, headers: HeaderMap, Json(req): Json<DeleteReq>) -> Response {
    match gate(&state, &headers, Some(&req.project)) {
        Ok(root) => phone::do_delete(&state, &root, req),
        Err(refusal) => refusal,
    }
}
