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
    instance_on(name, deny, Arc::new(db))
}

/// A machine named `name`; a name that's a kind (`laptop`, …) is also its kind.
fn instance_on(name: &str, deny: Arc<AtomicBool>, db: Arc<Db>) -> Arc<Fleet> {
    instance_with(name, deny, db, Arc::new(Book::default()))
}

fn instance_with(name: &str, deny: Arc<AtomicBool>, db: Arc<Db>, book: Arc<Book>) -> Arc<Fleet> {
    let fleet = Fleet::new(test_config(name), Box::new(Loop { deny }), storage(db), book, Box::new(|| {}));
    tokio::spawn(fleet.clone().run());
    fleet
}

/// A machine's paired devices, as the remote server would keep them.
#[derive(Default)]
struct Book(std::sync::Mutex<Vec<PairedDevice>>);

impl DeviceBook for Book {
    fn devices(&self) -> Vec<PairedDevice> {
        self.0.lock().unwrap().clone()
    }
    fn merge_devices(&self, incoming: &[PairedDevice]) -> bool {
        let mut list = self.0.lock().unwrap();
        let changes = proto::merge_devices(&list, incoming);
        for c in &changes {
            list.retain(|d| d.id != c.id);
            list.push(c.clone());
        }
        !changes.is_empty()
    }
}

impl Book {
    fn get(&self, id: &str) -> Option<PairedDevice> {
        self.0.lock().unwrap().iter().find(|d| d.id == id).cloned()
    }
    /// A change made on this machine (pairing, approval, revoke).
    fn put(&self, d: PairedDevice) {
        let mut list = self.0.lock().unwrap();
        list.retain(|x| x.id != d.id);
        list.push(d);
    }
}

fn test_config(name: &str) -> Config {
    Config {
        port: 0,
        default_name: name.into(),
        default_kind: if proto::valid_kind(name) { name.into() } else { "desktop".into() },
        version: "9.9.9".into(),
        tick: Duration::from_millis(100),
    }
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
            Config { tick: Duration::from_secs(9), ..test_config("x") },
            Box::new(Loop { deny: ok.clone() }),
            storage(db.clone()),
            Arc::new(Book::default()),
            Box::new(|| {}),
        );
        a.rename("named");
        let id = a.status().me.id;
        drop(a);
        let b = Fleet::new(
            Config { tick: Duration::from_secs(9), ..test_config("y") },
            Box::new(Loop { deny: ok }),
            storage(db),
            Arc::new(Book::default()),
            Box::new(|| {}),
        );
        assert_eq!(b.status().me.id, id);
        assert_eq!(b.status().me.name, "named");
    });
}

fn id_of(f: &Fleet, name: &str) -> String {
    let s = f.status();
    if s.me.name == name {
        return s.me.id;
    }
    s.members.into_iter().find(|m| m.name == name).unwrap().id
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_order_and_the_pin_travel_and_survive_a_restart() {
    let ok = Arc::new(AtomicBool::new(false));
    let desktop = instance("desktop", ok.clone());
    let laptop_db = Arc::new(Db::open_in_memory().unwrap());
    let laptop = instance_on("laptop", ok.clone(), laptop_db.clone());
    let code = join_string(&desktop).await;
    laptop.join(&code).await.unwrap();
    until("linked", || online(&desktop, "laptop") && online(&laptop, "desktop")).await;
    let (d, l) = (id_of(&laptop, "desktop"), id_of(&desktop, "laptop"));

    // The default: by kind, no main by hand, the desktop the list's first choice.
    let c = laptop.status().config;
    assert_eq!(c.order, vec![d.clone(), l.clone()]);
    assert!(!c.custom_order);
    assert_eq!(c.main, None);
    assert_eq!(c.first_choice, Some(d.clone()));

    // The laptop puts itself first and pins the main to itself; the desktop hears it.
    laptop.set_order(vec![l.clone(), d.clone()]);
    laptop.set_pin(Some(l.clone())).unwrap();
    until("the desktop has the new order and pin", || {
        let c = desktop.status().config;
        c.order == vec![l.clone(), d.clone()] && c.main.as_deref() == Some(l.as_str())
    })
    .await;
    assert_eq!(desktop.status().config.by.as_deref(), Some("laptop"));

    // The desktop answers: the laptop can't be main, which drops the pin.
    desktop.set_can_be_main(&l, false);
    until("the laptop hears it", || {
        let c = laptop.status().config;
        c.not_main == vec![l.clone()] && c.pin.is_none() && c.first_choice.as_deref() == Some(d.as_str())
    })
    .await;

    // A machine that joins later gets the settings in the join's answer.
    let server = instance("server", ok.clone());
    let code = join_string(&laptop).await;
    server.join(&code).await.unwrap();
    let s = server.status().config;
    assert_eq!(s.not_main, vec![l.clone()]);
    assert_eq!(&s.order[..2], &[l.clone(), d.clone()]);
    // Not in the hand-set order: after it, by kind.
    assert_eq!(s.order[2], server.status().me.id);

    // The laptop restarts (a second instance on its database): the settings are there.
    let again = Fleet::new(
        Config { tick: Duration::from_secs(9), ..test_config("laptop") },
        Box::new(Loop { deny: ok.clone() }),
        storage(laptop_db),
        Arc::new(Book::default()),
        Box::new(|| {}),
    );
    let c = again.status().config;
    assert_eq!(c.not_main, vec![l.clone()]);
    assert_eq!(&c.order[..2], &[l.clone(), d.clone()]);
    assert_eq!(again.status().me.kind, "laptop");

    // Its kind is its own to change, and travels.
    laptop.set_kind("server").unwrap();
    assert!(laptop.set_kind("toaster").is_err());
    until("the new kind", || desktop.status().members.iter().any(|m| m.id == l && m.kind == "server")).await;

    // Leaving forgets the fleet's settings.
    laptop.remove(&l);
    until("the laptop left", || laptop.status().members.is_empty()).await;
    assert!(!laptop.status().config.custom_order);
    assert!(laptop.status().config.not_main.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_phone_paired_on_one_machine_is_paired_on_all() {
    let ok = Arc::new(AtomicBool::new(false));
    let (dbook, lbook, sbook) = (Arc::new(Book::default()), Arc::new(Book::default()), Arc::new(Book::default()));
    let desktop = instance_with("desktop", ok.clone(), Arc::new(Db::open_in_memory().unwrap()), dbook.clone());
    let laptop = instance_with("laptop", ok.clone(), Arc::new(Db::open_in_memory().unwrap()), lbook.clone());
    // Paired on the laptop before it joined: it arrives with the link.
    let phone = PairedDevice {
        id: "phone".into(),
        token: "tok".into(),
        name: "Pixel".into(),
        paired_at: 1,
        approved: false,
        public_key: Some("key".into()),
        last_seen: None,
        updated_at: 10,
        removed: false,
    };
    lbook.put(phone.clone());
    let code = join_string(&desktop).await;
    laptop.join(&code).await.unwrap();
    until("the desktop has the phone", || dbook.get("phone").is_some()).await;
    assert!(!dbook.get("phone").unwrap().approved);

    // Approved on the desktop: approved on the laptop.
    dbook.put(PairedDevice { approved: true, updated_at: 20, ..phone.clone() });
    desktop.devices_changed();
    until("approved on the laptop", || lbook.get("phone").unwrap().approved).await;

    // A third machine gets it from the laptop, and passes nothing back that loops.
    let server = instance_with("server", ok.clone(), Arc::new(Db::open_in_memory().unwrap()), sbook.clone());
    let code = join_string(&laptop).await;
    server.join(&code).await.unwrap();
    until("the server has it", || sbook.get("phone").is_some_and(|d| d.approved)).await;

    // Used on the server: the others count its 30 days from then.
    sbook.put(PairedDevice { last_seen: Some(999), ..sbook.get("phone").unwrap() });
    server.devices_changed();
    until("the last use travels", || {
        dbook.get("phone").unwrap().last_seen == Some(999) && lbook.get("phone").unwrap().last_seen == Some(999)
    })
    .await;

    // Revoked on the server: revoked everywhere, and it stays so.
    sbook.put(PairedDevice::tombstone("phone", 30));
    server.devices_changed();
    until("revoked everywhere", || dbook.get("phone").unwrap().removed && lbook.get("phone").unwrap().removed).await;
    laptop.devices_changed();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(dbook.get("phone").unwrap().removed);
    assert!(dbook.get("phone").unwrap().token.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_phone_learns_every_machines_address() {
    let ok = Arc::new(AtomicBool::new(false));
    let desktop = instance("desktop", ok.clone());
    let laptop = instance("laptop", ok.clone());
    let code = join_string(&desktop).await;
    laptop.join(&code).await.unwrap();
    until("linked", || online(&desktop, "laptop")).await;
    laptop.set_public_url(Some("https://laptop.t.ts.net".into()));
    desktop.set_public_url(Some("https://desktop.t.ts.net".into()));
    until("the laptop's address", || {
        desktop.status().members[0].public_url.as_deref() == Some("https://laptop.t.ts.net")
    })
    .await;
    let list = desktop.phone_list();
    let names: Vec<&str> = list.instances.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(names, ["desktop", "laptop"]);
    // No pin: the list's first choice is the main.
    assert!(!list.pinned);
    assert_eq!(list.main.as_deref(), Some(list.instances[0].id.as_str()));
    assert!(list.instances[0].main && list.instances[0].here);
    assert_eq!(list.instances[1].url.as_deref(), Some("https://laptop.t.ts.net"));
    assert!(list.instances[1].online);

    // Pinned to the laptop: the laptop is main for the phone too.
    let l = list.instances[1].id.clone();
    desktop.set_pin(Some(l.clone())).unwrap();
    let list = desktop.phone_list();
    assert!(list.pinned);
    assert_eq!(list.main, Some(l));
    assert!(list.instances[1].main && !list.instances[0].main);
}
