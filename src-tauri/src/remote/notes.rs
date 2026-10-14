//! Project notes for the phone (step R8): the N1 notes module, served to paired
//! devices. The handlers call it directly in Rust, so they work while the desktop
//! window is minimised or showing another project.
//!
//! A request names a project id and a note id only — never a path. The project
//! must exist in the registry, and the notes module refuses an id that isn't a
//! plain file name, so nothing outside a project's notes folder is reachable. A
//! save names the revision it was edited from; when the note moved on, the answer
//! is 409 with the note as it is now, so the phone can show both versions.
//!
//! Every change goes through `notes::notify`: the desktop panel hears it as
//! `notes-changed`, and every connected phone as a `notes` frame on the dashboard
//! socket (`super::push_notes_changed`).
//!
//! - `GET  /api/notes` — `[{projectId, count}]` for every project.
//! - `GET  /api/notes/list?project=` — the project's notes, newest first.
//! - `GET  /api/notes/read?project=&id=` — one note with its revision.
//! - `POST /api/notes/create {project, name, content}` — a new note; a taken name
//!   gets " 2", " 3", …
//! - `POST /api/notes/save {project, id, content, base}` — `{revision}`, or 409.
//! - `POST /api/notes/rename {project, id, to}`, `POST /api/notes/delete {project, id}`.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use super::server::{authed, bearer, client_addr};
use super::RemoteState;
use crate::db::Db;
use crate::notes::{self, Note};
use tauri::Manager;

#[allow(clippy::result_large_err)] // a refusal is built once per refused request
/// The bearer check, then the notes root and a known project.
fn gate(
    state: &Arc<RemoteState>,
    peer: SocketAddr,
    headers: &HeaderMap,
    project: Option<&str>,
) -> Result<std::path::PathBuf, Response> {
    authed(state, bearer(headers).as_deref(), &client_addr(peer, headers))?;
    if let Some(project) = project {
        let db = state.app.state::<Db>();
        let conn = db.conn.lock().expect("db lock poisoned");
        if crate::registry::get_project(&conn, project).is_err() {
            return Err(refuse(StatusCode::NOT_FOUND, "no such project"));
        }
    }
    notes::notes_root(&state.app).map_err(|e| refuse(StatusCode::INTERNAL_SERVER_ERROR, &e))
}

fn refuse(status: StatusCode, error: &str) -> Response {
    (status, Json(json!({ "error": error }))).into_response()
}

/// A notes-module error: a bad name is the client's fault, the rest is ours to say.
fn failed(error: String) -> Response {
    refuse(StatusCode::BAD_REQUEST, &error)
}

/// A note as the phone sees it: without the file path, which is this machine's.
fn note_json(note: &Note) -> Response {
    Json(json!({ "id": note.id, "content": note.content, "revision": note.revision })).into_response()
}

pub(super) async fn counts(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let root = match gate(&state, peer, &headers, None) {
        Ok(root) => root,
        Err(refusal) => return refusal,
    };
    let projects = {
        let db = state.app.state::<Db>();
        let conn = db.conn.lock().expect("db lock poisoned");
        crate::registry::list_projects(&conn).unwrap_or_default()
    };
    let counts: Vec<_> = projects
        .iter()
        .map(|p| json!({ "projectId": p.id, "count": notes::list(&root, &p.id).map_or(0, |l| l.len()) }))
        .collect();
    Json(counts).into_response()
}

#[derive(Deserialize)]
pub(super) struct ProjectQuery {
    #[serde(default)]
    project: String,
    #[serde(default)]
    id: String,
}

pub(super) async fn list(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<ProjectQuery>,
) -> Response {
    let root = match gate(&state, peer, &headers, Some(&q.project)) {
        Ok(root) => root,
        Err(refusal) => return refusal,
    };
    match notes::list(&root, &q.project) {
        Ok(list) => Json(list).into_response(),
        Err(e) => failed(e),
    }
}

pub(super) async fn read(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<ProjectQuery>,
) -> Response {
    let root = match gate(&state, peer, &headers, Some(&q.project)) {
        Ok(root) => root,
        Err(refusal) => return refusal,
    };
    match notes::read(&root, &q.project, &q.id) {
        Ok(note) => note_json(&note),
        Err(e) if e.contains("no longer exists") => refuse(StatusCode::NOT_FOUND, &e),
        Err(e) => failed(e),
    }
}

#[derive(Deserialize)]
pub(super) struct CreateReq {
    project: String,
    name: String,
    #[serde(default)]
    content: String,
}

pub(super) async fn create(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<CreateReq>,
) -> Response {
    let root = match gate(&state, peer, &headers, Some(&req.project)) {
        Ok(root) => root,
        Err(refusal) => return refusal,
    };
    match notes::create_unique(&root, &req.project, req.name.trim(), &req.content) {
        Ok(note) => {
            notes::notify(&state.app, &req.project);
            note_json(&note)
        }
        Err(e) => failed(e),
    }
}

#[derive(Deserialize)]
pub(super) struct SaveReq {
    project: String,
    id: String,
    content: String,
    /// The revision the text was edited from; absent overwrites (after the phone
    /// showed both versions and the user chose theirs to go).
    #[serde(default)]
    base: Option<String>,
}

pub(super) async fn save(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<SaveReq>,
) -> Response {
    let root = match gate(&state, peer, &headers, Some(&req.project)) {
        Ok(root) => root,
        Err(refusal) => return refusal,
    };
    match notes::write(&root, &req.project, &req.id, &req.content, req.base.as_deref()) {
        Ok(revision) => {
            notes::notify(&state.app, &req.project);
            Json(json!({ "revision": revision })).into_response()
        }
        Err(e) if e.starts_with(notes::STALE) => {
            // The note as it is now (or null, deleted), so both versions can be shown.
            let current = notes::read(&root, &req.project, &req.id)
                .ok()
                .map(|n| json!({ "id": n.id, "content": n.content, "revision": n.revision }));
            (StatusCode::CONFLICT, Json(json!({ "error": e, "current": current }))).into_response()
        }
        Err(e) => failed(e),
    }
}

#[derive(Deserialize)]
pub(super) struct RenameReq {
    project: String,
    id: String,
    to: String,
}

pub(super) async fn rename(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<RenameReq>,
) -> Response {
    let root = match gate(&state, peer, &headers, Some(&req.project)) {
        Ok(root) => root,
        Err(refusal) => return refusal,
    };
    match notes::rename(&root, &req.project, &req.id, req.to.trim()) {
        Ok(()) => {
            notes::notify(&state.app, &req.project);
            StatusCode::OK.into_response()
        }
        Err(e) => failed(e),
    }
}

#[derive(Deserialize)]
pub(super) struct DeleteReq {
    project: String,
    id: String,
}

pub(super) async fn delete(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<DeleteReq>,
) -> Response {
    let root = match gate(&state, peer, &headers, Some(&req.project)) {
        Ok(root) => root,
        Err(refusal) => return refusal,
    };
    match notes::delete(&root, &req.project, &req.id) {
        Ok(()) => {
            notes::notify(&state.app, &req.project);
            StatusCode::OK.into_response()
        }
        Err(e) => failed(e),
    }
}
