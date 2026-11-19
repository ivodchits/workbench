//! Several fleet instances in one process, on loopback (fleet plan F1.1's Done when,
//! short of two real machines).

use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::*;

/// Loopback for the tailnet; `deny` makes every peer someone else's.
struct Loop {
    deny: Arc<AtomicBool>,
}

impl Net for Loop {
    fn tailnet_ip(&self) -> Option<IpAddr> {
        Some(IpAddr::V4(Ipv4Addr::LOCALHOST))
    }
    fn dns_name(&self) -> Option<String> {
        None
    }
    fn same_owner(&self, ip: IpAddr) -> Result<(), String> {
        if self.deny.load(Ordering::SeqCst) {
            Err(format!("{ip} belongs to another tailnet user"))
        } else {
            Ok(())
        }
    }
}

fn instance(name: &str, deny: Arc<AtomicBool>) -> Arc<Fleet> {
    instance_in(name, deny, Db::open_in_memory().unwrap())
}

fn storage(db: Arc<Db>) -> Storage {
    Storage::new(move |f| f(&db.conn.lock().unwrap()))
}

fn instance_in(name: &str, deny: Arc<AtomicBool>, db: Db) -> Arc<Fleet> {
    let fleet = Fleet::new(
        Config {
            port: 0,
            default_name: name.into(),
            version: "9.9.9".into(),
            tick: Duration::from_millis(100),
        },
        Box::new(Loop { deny }),
        storage(Arc::new(db)),
        Box::new(|| {}),
    );
    tokio::spawn(fleet.clone().run());
    fleet
}

async fn until(what: &str, f: impl Fn() -> bool) {
    for _ in 0..200 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for: {what}");
}

async fn join_string(f: &Arc<Fleet>) -> String {
    f.new_code().unwrap();
    until("the join string", || f.status().join_string.is_some()).await;
    f.status().join_string.unwrap()
}

fn online(f: &Fleet, name: &str) -> bool {
    f.status().members.iter().any(|m| m.name == name && m.online)
}

fn knows(f: &Fleet, name: &str) -> bool {
    f.status().members.iter().any(|m| m.name == name)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn machines_join_link_gossip_and_leave() {
    let ok = Arc::new(AtomicBool::new(false));
    let desktop = instance("desktop", ok.clone());
    let laptop = instance("laptop", ok.clone());

    // Nothing listens before there's a member or a code.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(desktop.status().listening.is_none());

    let code = join_string(&desktop).await;
    laptop.join(&code).await.unwrap();
    until("both online", || online(&desktop, "laptop") && online(&laptop, "desktop")).await;
    until("the beat", || {
        desktop.status().members[0].version.as_deref() == Some("9.9.9")
    })
    .await;
    // The code was used up.
    assert!(desktop.status().code.is_none());
    // Exactly one link, the same at both ends.
    let d = desktop.status().members[0].direction.clone().unwrap();
    let l = laptop.status().members[0].direction.clone().unwrap();
    assert_ne!(d, l, "one end dialed, the other accepted");

    // A third machine joins through the laptop; the desktop hears of it and links.
    let server = instance("server", ok.clone());
    let code = join_string(&laptop).await;
    server.join(&code).await.unwrap();
    until("the desktop links to the server", || {
        online(&desktop, "server") && online(&server, "desktop") && online(&server, "laptop")
    })
    .await;

    // A rename travels.
    laptop.rename("laptop-2");
    until("the new name", || knows(&desktop, "laptop-2") && knows(&server, "laptop-2")).await;

    // The desktop removes the server: everyone forgets it, and it forgets everyone.
    let server_id = server.status().me.id;
    desktop.remove(&server_id);
    until("the server is gone", || {
        !knows(&desktop, "server") && !knows(&laptop, "server") && server.status().members.is_empty()
    })
    .await;
    // And it stays gone: no one dials it back.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!knows(&laptop, "server"));
    assert!(server.status().members.is_empty());

    // The laptop leaves by itself.
    let laptop_id = laptop.status().me.id;
    laptop.remove(&laptop_id);
    until("the laptop left", || !knows(&desktop, "laptop-2") && laptop.status().members.is_empty()).await;

    // It can come back with a new code, its tombstone notwithstanding.
    let code = join_string(&desktop).await;
    laptop.join(&code).await.unwrap();
    until("the laptop is back", || online(&desktop, "laptop-2") && online(&laptop, "desktop")).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn joining_needs_the_code_and_the_same_owner() {
    let ok = Arc::new(AtomicBool::new(false));
    let desktop = instance("desktop", ok.clone());
    let laptop = instance("laptop", ok.clone());
    let code = join_string(&desktop).await;
    let (_, addr) = code.split_once('@').unwrap();

    let err = laptop.join(&format!("ZZZZZ-ZZZZZ@{addr}")).await.unwrap_err();
    assert!(err.contains("wrong code"), "{err}");
    assert!(!knows(&desktop, "laptop"));

    // Someone else's machine, with the right code. (A new desktop: the first one
    // remembers that loopback was fine.)
    let deny = Arc::new(AtomicBool::new(true));
    let other = instance("other", deny);
    let code = join_string(&other).await;
    let err = laptop.join(&code).await.unwrap_err();
    assert!(err.contains("another tailnet user"), "{err}");
    assert!(!knows(&other, "laptop"));
    assert!(other.status().log.iter().any(|f| f.what.contains("join refused")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_copied_identity_is_caught_and_reset() {
    let ok = Arc::new(AtomicBool::new(false));
    let desktop = instance("desktop", ok.clone());
    let laptop = instance("laptop", ok.clone());
    let code = join_string(&desktop).await;
    laptop.join(&code).await.unwrap();
    until("linked", || online(&desktop, "laptop")).await;

    // A new PC set up from a copy of the laptop's database: same id, same key.
    let copy_db = Db::open_in_memory().unwrap();
    {
        let (id, secret) = laptop.store.with(store::identity).unwrap();
        let conn = copy_db.conn.lock().unwrap();
        store::set_identity(&conn, &id, &secret).unwrap();
    }
    let copy = instance_in("pc", ok.clone(), copy_db);
    let code = join_string(&copy).await;
    // The laptop's own record can't join as itself.
    let err = laptop.join(&code).await.unwrap_err();
    assert!(err.contains("identity"), "{err}");
    // The copy, joining the desktop, is told and starts over with its own identity.
    let code = join_string(&desktop).await;
    assert!(copy.join(&code).await.is_err());
    copy.reset_identity();
    assert_ne!(copy.status().me.id, laptop.status().me.id);
    let code = join_string(&desktop).await;
    copy.join(&code).await.unwrap();
    until("all three linked", || {
        online(&desktop, "pc") && online(&laptop, "pc") && online(&desktop, "laptop")
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_impostor_with_a_members_id_is_refused() {
    let ok = Arc::new(AtomicBool::new(false));
    let desktop = instance("desktop", ok.clone());
    let laptop = instance("laptop", ok.clone());
    let code = join_string(&desktop).await;
    laptop.join(&code).await.unwrap();
    until("linked", || online(&desktop, "laptop")).await;

    // Someone who knows the laptop's id but not its key dials the desktop.
    let addr = desktop.status().listening.unwrap();
    let laptop_id = laptop.status().me.id;
    let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/fleet/link")).await.unwrap();
    let (mut inbound, out) = link::tests_pump(socket);
    out.send(Frame::Hello { id: laptop_id.clone(), nonce: "n".into(), v: 1 }.to_text()).unwrap();
    let hello = inbound.recv().await.unwrap();
    assert!(matches!(Frame::parse(&hello), Some(Frame::Hello { .. })));
    let _their_proof = inbound.recv().await.unwrap();
    let fake = SigningKey::random(&mut OsRng);
    let sig = proto::sign(&fake, "anything");
    out.send(Frame::Proof { sig }.to_text()).unwrap();
    let answer = inbound.recv().await.unwrap();
    assert!(matches!(Frame::parse(&answer), Some(Frame::Bye { .. })), "{answer}");
    until("logged", || desktop.status().log.iter().any(|f| f.what.contains("proof failed"))).await;
    // The real laptop's link is untouched.
    assert!(online(&desktop, "laptop"));
}

#[test]
fn identity_survives_a_restart() {
    // The same database twice: the same id, key and members.
    let db = Arc::new(Db::open_in_memory().unwrap());
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let ok = Arc::new(AtomicBool::new(false));
        let a = Fleet::new(
            Config { port: 0, default_name: "x".into(), version: "1".into(), tick: Duration::from_secs(9) },
            Box::new(Loop { deny: ok.clone() }),
            storage(db.clone()),
            Box::new(|| {}),
        );
        a.rename("named");
        let id = a.status().me.id;
        drop(a);
        let b = Fleet::new(
            Config { port: 0, default_name: "y".into(), version: "1".into(), tick: Duration::from_secs(9) },
            Box::new(Loop { deny: ok }),
            storage(db),
            Box::new(|| {}),
        );
        assert_eq!(b.status().me.id, id);
        assert_eq!(b.status().me.name, "named");
    });
}
