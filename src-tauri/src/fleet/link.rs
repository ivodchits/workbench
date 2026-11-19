//! The fleet's listener and its links (fleet plan F1.1): `/fleet/join` and
//! `/fleet/link` served on the tailnet address, the dialer, and one link's life —
//! handshake, gossip, beats — over text channels, so the same code runs whichever
//! side dialed.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, DefaultBodyLimit, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::mpsc;
use tokio::time::{sleep_until, timeout, Instant};

use super::proto::{self, Frame, Member, LINK_VERSION};
use super::{Fleet, JoinRequest, BEAT_EVERY, HANDSHAKE, SILENCE};
use crate::remote::auth;

/// Bind `addr` and serve the fleet's routes there. The bound address (its port, when
/// 0 was asked) and the server's task.
pub(super) async fn listen(
    fleet: Arc<Fleet>,
    addr: SocketAddr,
) -> std::io::Result<(SocketAddr, tokio::task::JoinHandle<()>)> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let bound = listener.local_addr()?;
    let app = Router::new()
        .route("/fleet/join", post(join))
        .route("/fleet/link", get(accept))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(fleet);
    let task = tokio::spawn(async move {
        let svc = app.into_make_service_with_connect_info::<SocketAddr>();
        if let Err(e) = axum::serve(listener, svc).await {
            eprintln!("[fleet] the listener stopped: {e}");
        }
    });
    Ok((bound, task))
}

fn refuse(status: StatusCode, why: &str) -> Response {
    (status, Json(json!({ "error": why }))).into_response()
}

async fn join(
    State(fleet): State<Arc<Fleet>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    Json(req): Json<JoinRequest>,
) -> Response {
    if let Err(why) = fleet.check_owner(from.ip()).await {
        fleet.log_failure(&from.ip().to_string(), &format!("join refused: {why}"));
        return refuse(StatusCode::FORBIDDEN, &why);
    }
    match fleet.accept_join(req, from.ip()) {
        Ok(answer) => Json(answer).into_response(),
        Err(why) => refuse(StatusCode::FORBIDDEN, &why),
    }
}

async fn accept(
    State(fleet): State<Arc<Fleet>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    ws: WebSocketUpgrade,
) -> Response {
    if let Err(why) = fleet.check_owner(from.ip()).await {
        fleet.log_failure(&from.ip().to_string(), &format!("link refused: {why}"));
        return refuse(StatusCode::FORBIDDEN, &why);
    }
    ws.on_upgrade(move |socket| async move {
        let (inbound, out) = pump_axum(socket);
        run(fleet, false, None, from.ip(), inbound, out).await;
    })
}

/// Dial `m`. True when a link came up (whatever ended it later).
pub(super) async fn dial(fleet: Arc<Fleet>, m: &Member) -> bool {
    let Ok(ip) = m.ip.parse::<IpAddr>() else { return false };
    if fleet.check_owner(ip).await.is_err() {
        return false;
    }
    let url = format!("ws://{}/fleet/link", SocketAddr::new(ip, m.port));
    let Ok(Ok((socket, _))) = timeout(HANDSHAKE, tokio_tungstenite::connect_async(url)).await else {
        return false;
    };
    let (inbound, out) = pump_client(socket);
    run(fleet, true, Some(m.id.clone()), ip, inbound, out).await
}

/// An axum socket as two text channels. Dropping every sender of `out` closes it.
fn pump_axum(socket: WebSocket) -> (mpsc::Receiver<String>, mpsc::UnboundedSender<String>) {
    let (mut sink, mut stream) = socket.split();
    let (in_tx, in_rx) = mpsc::channel::<String>(64);
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(text) = out_rx.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                Message::Text(t) if in_tx.send(t.to_string()).await.is_err() => break,
                Message::Close(_) => break,
                _ => {}
            }
        }
    });
    (in_rx, out_tx)
}

type ClientSocket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn pump_client(socket: ClientSocket) -> (mpsc::Receiver<String>, mpsc::UnboundedSender<String>) {
    use tokio_tungstenite::tungstenite::Message as M;
    let (mut sink, mut stream) = socket.split();
    let (in_tx, in_rx) = mpsc::channel::<String>(64);
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(text) = out_rx.recv().await {
            if sink.send(M::Text(text.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                M::Text(t) if in_tx.send(t.to_string()).await.is_err() => break,
                M::Close(_) => break,
                _ => {}
            }
        }
    });
    (in_rx, out_tx)
}

#[cfg(test)]
pub(super) fn tests_pump(socket: ClientSocket) -> (mpsc::Receiver<String>, mpsc::UnboundedSender<String>) {
    pump_client(socket)
}

async fn next_frame(inbound: &mut mpsc::Receiver<String>) -> Option<Frame> {
    match timeout(HANDSHAKE, inbound.recv()).await {
        Ok(Some(text)) => Frame::parse(&text),
        _ => None,
    }
}

fn bye(out: &mpsc::UnboundedSender<String>, reason: &str) {
    let _ = out.send(Frame::Bye { reason: reason.into() }.to_text());
}

/// One link's life, from the handshake on. `dialed`: this machine dialed it, expecting
/// `expect`. True when the handshake passed.
async fn run(
    fleet: Arc<Fleet>,
    dialed: bool,
    expect: Option<String>,
    from: IpAddr,
    mut inbound: mpsc::Receiver<String>,
    out: mpsc::UnboundedSender<String>,
) -> bool {
    let addr = from.to_string();
    let me = fleet.me();
    let nonce = auth::random_token();
    let _ = out.send(Frame::Hello { id: me.clone(), nonce: nonce.clone(), v: LINK_VERSION }.to_text());

    let Some(Frame::Hello { id: peer, nonce: their_nonce, .. }) = next_frame(&mut inbound).await else {
        bye(&out, "no hello");
        return false;
    };
    if peer == me {
        fleet.identity_clash(&addr);
        bye(&out, "you have my identity");
        return false;
    }
    if expect.as_ref().is_some_and(|e| e != &peer) {
        fleet.log_failure(&addr, "a different machine answered at a member’s address");
        bye(&out, "not who I dialed");
        return false;
    }
    let Some(peer_key) = fleet.member_key(&peer) else {
        fleet.log_failure(&addr, "a link from a machine that isn’t a member");
        bye(&out, "not a member here");
        return false;
    };
    let sig = {
        let inner = fleet.inner.lock().unwrap();
        proto::sign(&inner.key, &proto::link_statement(&their_nonce, &me, &peer))
    };
    let _ = out.send(Frame::Proof { sig }.to_text());
    let Some(Frame::Proof { sig }) = next_frame(&mut inbound).await else {
        bye(&out, "no proof");
        return false;
    };
    if !proto::verify(&peer_key, &proto::link_statement(&nonce, &peer, &me), &sig) {
        fleet.log_failure(&addr, "a link whose key proof failed");
        bye(&out, "the proof failed");
        return false;
    }
    let dialer = if dialed { me.clone() } else { peer.clone() };
    let Some((link_id, mut cancel)) = fleet.register_link(&peer, &dialer, out.clone()) else {
        bye(&out, "a link is already up");
        return true;
    };

    let _ = out.send(Frame::Members { list: fleet.inner.lock().unwrap().members.clone() }.to_text());
    let _ = out.send(Frame::Beat { beat: fleet.beat() }.to_text());
    let mut beats = tokio::time::interval(BEAT_EVERY);
    beats.tick().await; // the first tick is now; the beat just went
    let mut heard = Instant::now();
    loop {
        tokio::select! {
            msg = inbound.recv() => {
                let Some(text) = msg else { break };
                heard = Instant::now();
                match Frame::parse(&text) {
                    Some(Frame::Members { list }) => fleet.take_members(Some(&peer), list),
                    Some(Frame::Beat { beat }) => fleet.on_beat(&peer, beat),
                    Some(Frame::Bye { reason }) => {
                        let name = fleet.name_of(&peer).unwrap_or(peer.clone());
                        if reason != "replaced by a newer link" {
                            eprintln!("[fleet] {name} closed the link: {reason}");
                        }
                        break;
                    }
                    _ => {}
                }
            }
            _ = beats.tick() => {
                if out.send(Frame::Beat { beat: fleet.beat() }.to_text()).is_err() {
                    break;
                }
            }
            why = &mut cancel => {
                bye(&out, &why.unwrap_or_else(|_| "closing".into()));
                break;
            }
            _ = sleep_until(heard + SILENCE) => break,
        }
    }
    fleet.unregister_link(&peer, link_id);
    true
}
