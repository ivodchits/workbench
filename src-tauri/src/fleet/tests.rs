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
    /// The LAN this machine says it's on (F4.1), and the packets it sent.
    lan: Option<proto::Lan>,
    sent: Sent,
}

/// The Wake-on-LAN packets a machine sent: (MAC, broadcast address).
type Sent = Arc<std::sync::Mutex<Vec<([u8; 6], std::net::Ipv4Addr)>>>;

impl Loop {
    fn new(deny: Arc<AtomicBool>) -> Loop {
        Loop { deny, lan: None, sent: Arc::default() }
    }
}

impl Net for Loop {
    fn tailnet_ip(&self) -> Option<IpAddr> {
        Some(IpAddr::V4(Ipv4Addr::LOCALHOST))
    }
    fn dns_name(&self) -> Option<String> {
        None
    }
    fn lan(&self) -> Option<proto::Lan> {
        self.lan.clone()
    }
    fn send_wake(&self, mac: [u8; 6], broadcast: std::net::Ipv4Addr) -> Result<(), String> {
        self.sent.lock().unwrap().push((mac, broadcast));
        Ok(())
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
    let fleet = Fleet::new(test_config(name), Box::new(Loop::new(deny)), storage(db), book, Box::new(|| {}));
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
    fn relay_session(&self, device: &str) -> Result<String, String> {
        match self.get(device) {
            Some(d) if d.approved && !d.removed => Ok(format!("session-for-{device}")),
            Some(_) => Err("not approved here".into()),
            None => Err("no such device here".into()),
        }
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
        // Longer than the 5 s between beats, which renew the lease.
        failover: Duration::from_millis(6500),
        handover_after: Duration::from_millis(800),
    }
}

async fn until(what: &str, f: impl Fn() -> bool) {
    for _ in 0..300 {
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
            Box::new(Loop::new(ok.clone())),
            storage(db.clone()),
            Arc::new(Book::default()),
            Box::new(|| {}),
        );
        a.rename("named");
        let id = a.status().me.id;
        drop(a);
        let b = Fleet::new(
            Config { tick: Duration::from_secs(9), ..test_config("y") },
            Box::new(Loop::new(ok)),
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
        Box::new(Loop::new(ok.clone())),
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
    // The lease moves to the pin by a handover (F6.1).
    until("the laptop holds", || desktop.phone_list().main.as_deref() == Some(l.as_str())).await;
    let list = desktop.phone_list();
    assert!(list.pinned);
    assert!(list.instances.iter().find(|i| i.id == l).unwrap().main);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_machine_relays_to_another_and_duck_goes_to_the_main() {
    let ok = Arc::new(AtomicBool::new(false));
    let (dbook, lbook) = (Arc::new(Book::default()), Arc::new(Book::default()));
    let desktop = instance_with("desktop", ok.clone(), Arc::new(Db::open_in_memory().unwrap()), dbook.clone());
    let laptop = instance_with("laptop", ok.clone(), Arc::new(Db::open_in_memory().unwrap()), lbook.clone());
    let code = join_string(&desktop).await;
    laptop.join(&code).await.unwrap();
    until("linked", || online(&desktop, "laptop") && online(&laptop, "desktop")).await;
    let (d, l) = (id_of(&laptop, "desktop"), id_of(&desktop, "laptop"));

    // Neither remote server listens yet: nowhere to relay, and Duck answers where asked.
    assert_eq!(laptop.relay_target(&d), None);
    assert_eq!(laptop.duck_main(), None);

    desktop.set_remote_port(Some(49020));
    laptop.set_remote_port(Some(49021));
    until("the desktop's port in a beat", || laptop.relay_target(&d).is_some()).await;
    assert_eq!(laptop.relay_target(&d).unwrap().port(), 49020);
    // Its own: loopback.
    assert_eq!(laptop.relay_target(&l).unwrap().to_string(), "127.0.0.1:49021");

    // The desktop is the main (first by kind): the laptop sends Duck there; the
    // desktop keeps it.
    assert_eq!(laptop.duck_main(), Some(d.clone()));
    assert_eq!(desktop.duck_main(), None);
    // Pinned to the laptop: the other way round.
    desktop.set_pin(Some(l.clone())).unwrap();
    // The lease moves to the pin by a handover (F6.1).
    until("handed to the pin", || laptop.duck_main().is_none() && desktop.duck_main() == Some(l.clone())).await;

    // A session for an approved phone, asked over the link; a stranger gets none.
    let phone = PairedDevice {
        id: "phone".into(),
        token: "tok".into(),
        name: "Pixel".into(),
        paired_at: 1,
        approved: true,
        public_key: None,
        last_seen: None,
        updated_at: 10,
        removed: false,
    };
    dbook.put(phone);
    assert_eq!(laptop.relay_session(&d, "phone", false).await.unwrap(), "session-for-phone");
    let err = laptop.relay_session(&d, "stranger", false).await.unwrap_err();
    assert!(err.contains("no such device"), "{err}");
    // Kept: the desktop isn't asked again (it would refuse now).
    dbook.put(PairedDevice::tombstone("phone", 20));
    assert_eq!(laptop.relay_session(&d, "phone", false).await.unwrap(), "session-for-phone");
    assert!(laptop.relay_session(&d, "phone", true).await.is_err());
    // This machine's own: from its own book.
    assert!(laptop.relay_session(&l, "phone", false).await.is_err());

    // A machine that isn't linked can't be asked.
    let err = laptop.relay_session("nobody", "phone", false).await.unwrap_err();
    assert!(err.contains("isn’t connected"), "{err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn host_traffic_travels_between_two_machines() {
    let ok = Arc::new(AtomicBool::new(false));
    let desktop = instance("desktop", ok.clone());
    let laptop = instance("laptop", ok.clone());
    let got = Arc::new(std::sync::Mutex::new(Vec::<(String, String)>::new()));
    let sink = got.clone();
    desktop.on_host(Box::new(move |from, text| sink.lock().unwrap().push((from.to_string(), text))));
    assert!(laptop.send_host("nobody", "x".into()).is_err());
    let code = join_string(&desktop).await;
    laptop.join(&code).await.unwrap();
    until("linked", || online(&desktop, "laptop") && online(&laptop, "desktop")).await;
    let d = id_of(&laptop, "desktop");
    let l = id_of(&desktop, "laptop");
    laptop.send_host(&d, r#"{"ch":"pc","msg":{"type":"hello"}}"#.into()).unwrap();
    until("delivered", || !got.lock().unwrap().is_empty()).await;
    assert_eq!(got.lock().unwrap()[0], (l, r#"{"ch":"pc","msg":{"type":"hello"}}"#.to_string()));
    // Duck runs on the desktop (first by kind), as both see it.
    assert_eq!(laptop.status().config.duck, Some(d.clone()));
    assert_eq!(desktop.status().config.duck, Some(d));
}

fn lan(net: &str, mac: &str) -> proto::Lan {
    proto::Lan { mac: mac.into(), network: format!("{net}.0/24"), broadcast: format!("{net}.255") }
}

/// A machine on a LAN, with the packets it sends kept.
fn on_lan(name: &str, ok: Arc<AtomicBool>, l: Option<proto::Lan>) -> (Arc<Fleet>, Sent) {
    let net = Loop { lan: l, ..Loop::new(ok) };
    let sent = net.sent.clone();
    let fleet = Fleet::new(
        test_config(name),
        Box::new(net),
        storage(Arc::new(Db::open_in_memory().unwrap())),
        Arc::new(Book::default()),
        Box::new(|| {}),
    );
    tokio::spawn(fleet.clone().run());
    (fleet, sent)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_machine_thats_off_is_woken_from_its_network() {
    let ok = Arc::new(AtomicBool::new(false));
    // The server and the desktop at home; the laptop away.
    let (server, server_sent) = on_lan("server", ok.clone(), Some(lan("192.168.1", "00:11:22:33:44:01")));
    let (laptop, laptop_sent) = on_lan("laptop", ok.clone(), Some(lan("10.0.0", "00:11:22:33:44:02")));
    let code = join_string(&server).await;
    laptop.join(&code).await.unwrap();
    until("linked", || online(&server, "laptop")).await;
    until("the LANs said", || server.status().members.iter().all(|m| m.wakeable)).await;

    // The desktop, off: known from before, with its LAN, never connecting here.
    let desk_key = SigningKey::random(&mut OsRng);
    let desktop = Member {
        id: "desk".into(),
        name: "desktop".into(),
        public_key: proto::public_key_b64(&desk_key),
        ip: "100.64.0.9".into(),
        port: 1,
        host: None,
        kind: "desktop".into(),
        public_url: None,
        lan: Some(lan("192.168.1", "aa:bb:cc:dd:ee:ff")),
        updated_at: now_ms(),
        removed: false,
    };
    server.take_members(None, vec![desktop]);
    until("the laptop knows the desktop", || knows(&laptop, "desktop")).await;

    // Not allowed yet.
    let err = laptop.wake("desk").await.unwrap_err();
    assert!(err.contains("isn’t set to be woken"), "{err}");
    laptop.set_wakeable("desk", true);
    until("allowed on the server", || server.status().config.wake.contains(&"desk".to_string())).await;

    // From the laptop, away: the server, at home, sends it.
    let said = laptop.wake("desk").await.unwrap();
    assert_eq!(said, "sent to desktop by server");
    let mac = proto::parse_mac("aa:bb:cc:dd:ee:ff").unwrap();
    assert_eq!(server_sent.lock().unwrap().as_slice(), &[(mac, "192.168.1.255".parse().unwrap())]);
    assert!(laptop_sent.lock().unwrap().is_empty());
    // From the server itself: from here.
    assert_eq!(server.wake("desk").await.unwrap(), "sent to desktop from here");

    // A machine that's on is on.
    let l = id_of(&server, "laptop");
    server.set_wakeable(&l, true);
    assert!(server.wake(&l).await.unwrap().contains("is on already"));
}

/// A machine's `duck.db` (a few of Duck's tables, with the log) and its copy file.
fn duck_files(name: &str) -> (Arc<std::sync::Mutex<Connection>>, DuckRepl) {
    duck_files_with(
        name,
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE assistant_threads (id TEXT PRIMARY KEY, title TEXT, updated INTEGER);
         CREATE TABLE assistant_messages (thread_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT, PRIMARY KEY (thread_id, seq));",
    )
}

/// Duck's threads and messages as `duck.db` has them.
const REAL_THREADS: &str = "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
     CREATE TABLE assistant_threads (id TEXT PRIMARY KEY, title TEXT, mode TEXT, created INTEGER, updated INTEGER, keep INTEGER);
     CREATE TABLE assistant_messages (thread_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER, role TEXT, content TEXT, source TEXT, PRIMARY KEY (thread_id, seq));";

fn duck_files_with(name: &str, schema: &str) -> (Arc<std::sync::Mutex<Connection>>, DuckRepl) {
    let dir = std::env::temp_dir().join(format!("wb-fleet-repl-{}-{name}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let conn = Connection::open(dir.join("duck.db")).unwrap();
    conn.execute_batch(schema).unwrap();
    repl::install(&conn).unwrap();
    let conn = Arc::new(std::sync::Mutex::new(conn));
    let c = conn.clone();
    let d = DuckRepl {
        source: Storage::new(move |f| f(&c.lock().unwrap())),
        replica: std::sync::Mutex::new(repl::Replica::new(dir.join("duck.replica.db"))),
        scratch: dir.join("snapshot.db"),
        workspace: std::sync::Mutex::new(Some(dir.join("workspace"))),
        mirror: dir.join("mirror"),
        files: dir.join("attachments"),
    };
    (conn, d)
}

fn dump(c: &Connection) -> Vec<String> {
    let mut out = Vec::new();
    for t in ["assistant_threads", "assistant_messages", "meta"] {
        let mut stmt = c.prepare(&format!("SELECT * FROM {t} ORDER BY 1, 2")).unwrap();
        let n = stmt.column_count();
        let rows = stmt
            .query_map([], |r| {
                Ok((0..n).map(|i| format!("{:?}", r.get::<_, rusqlite::types::Value>(i).unwrap())).collect::<Vec<_>>().join("|"))
            })
            .unwrap();
        out.extend(rows.map(|r| format!("{t}: {}", r.unwrap())));
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_mains_duck_state_is_copied_row_for_row() {
    let ok = Arc::new(AtomicBool::new(false));
    let desktop = instance("desktop", ok.clone());
    let laptop = instance("laptop", ok.clone());
    let (desk_db, desk_repl) = duck_files("desktop");
    let (_lap_db, lap_repl) = duck_files("laptop");
    desktop.set_duck(desk_repl);
    laptop.set_duck(lap_repl);
    {
        let c = desk_db.lock().unwrap();
        c.execute("INSERT INTO assistant_threads VALUES ('t1', 'first', 1)", []).unwrap();
        c.execute("INSERT INTO assistant_messages VALUES ('t1', 1, 'hello')", []).unwrap();
    }
    let code = join_string(&desktop).await;
    laptop.join(&code).await.unwrap();
    until("linked", || online(&desktop, "laptop")).await;

    let copy = |l: &Fleet| {
        let d = l.duck().unwrap();
        let mut r = d.replica.lock().unwrap();
        let st = r.state();
        drop(r);
        st
    };
    let matches = |l: &Fleet| {
        let d = l.duck().unwrap();
        let path = d.scratch.with_file_name("duck.replica.db");
        let Ok(c) = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else { return false };
        let theirs = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| dump(&c))).unwrap_or_default();
        theirs == dump(&desk_db.lock().unwrap())
    };
    // The first sync is a snapshot.
    until("the first copy", || matches(&laptop)).await;
    assert_eq!(laptop.status().replica.as_ref().unwrap().snapshots, 1);
    assert_eq!(laptop.status().replica.unwrap().of.as_deref(), Some("desktop"));
    // The desktop is Duck's main: it keeps no copy of the laptop's.
    assert!(desktop.status().replica.is_none());

    // Changes stream: an insert, an update, a delete.
    {
        let c = desk_db.lock().unwrap();
        c.execute("INSERT INTO assistant_messages VALUES ('t1', 2, 'how are you')", []).unwrap();
        c.execute("UPDATE assistant_threads SET title = 'renamed', updated = 2 WHERE id = 't1'", []).unwrap();
        c.execute("INSERT INTO assistant_threads VALUES ('t2', 'gone soon', 3)", []).unwrap();
        c.execute("DELETE FROM assistant_threads WHERE id = 't2'", []).unwrap();
        c.execute("INSERT INTO meta VALUES ('trust', '1')", []).unwrap();
    }
    until("the changes", || matches(&laptop)).await;
    assert_eq!(laptop.status().replica.unwrap().snapshots, 1, "no second snapshot for a few changes");

    // A lot of changes while the laptop's copy can't keep up (the log trimmed past
    // it): a snapshot again, and equal again.
    let before = copy(&laptop).seq;
    {
        let c = desk_db.lock().unwrap();
        for i in 3..1500 {
            c.execute("INSERT INTO assistant_messages VALUES ('t1', ?1, 'more')", [i]).unwrap();
        }
        repl::install_keeping(&c, 10).unwrap();
    }
    until("caught up after the gap", || matches(&laptop) && copy(&laptop).seq > before).await;

    // The desktop's database replaced (a new epoch): a snapshot.
    let snaps = laptop.status().replica.unwrap().snapshots;
    {
        let c = desk_db.lock().unwrap();
        c.execute("UPDATE repl_state SET v = 'another-epoch' WHERE k = 'epoch'", []).unwrap();
        c.execute("INSERT INTO assistant_threads VALUES ('t3', 'new life', 9)", []).unwrap();
    }
    until("re-copied", || matches(&laptop) && laptop.status().replica.unwrap().snapshots > snaps).await;
}

fn git(repo: &std::path::Path, args: &[&str]) {
    crate::gitqueue::run(repo, args).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_mains_repo_and_files_reach_the_other_machine() {
    let ok = Arc::new(AtomicBool::new(false));
    let desktop = instance("desktop", ok.clone());
    let laptop = instance("laptop", ok.clone());
    let (_d, desk) = duck_files("desktop");
    let (_l, lap) = duck_files("laptop");
    let ws = desk.workspace.lock().unwrap().clone().unwrap();
    let (mirror, desk_files, lap_files) = (lap.mirror.clone(), desk.files.clone(), lap.files.clone());
    std::fs::create_dir_all(&ws).unwrap();
    git(&ws, &["init", "-q"]);
    std::fs::write(ws.join("memory.md"), "the user likes tea").unwrap();
    git(&ws, &["add", "-A"]);
    git(&ws, &["-c", "user.name=Duck", "-c", "user.email=duck@localhost", "commit", "-q", "-m", "memory"]);
    desktop.set_duck(desk);
    laptop.set_duck(lap);
    let code = join_string(&desktop).await;
    laptop.join(&code).await.unwrap();
    until("linked", || online(&desktop, "laptop")).await;

    // Duck's repo: the laptop's mirror has the desktop's memory.
    until("the mirror", || std::fs::read_to_string(mirror.join("memory.md")).is_ok_and(|t| t == "the user likes tea")).await;
    assert_eq!(files::head(&mirror), files::head(&ws));
    until("said in the status", || laptop.status().replica.is_some_and(|r| r.repo.is_some())).await;

    // An attachment made on the desktop opens on the laptop.
    let att = crate::assistant::attachments::store_bytes(&desk_files, "photo.txt", b"a picture, in words").unwrap();
    assert!(crate::assistant::attachments::file_of(&lap_files, &att.id, "photo.txt").is_err());
    laptop.fetch_attachment(&att.id, "photo.txt").await.unwrap();
    let got = crate::assistant::attachments::file_of(&lap_files, &att.id, "photo.txt").unwrap();
    assert_eq!(std::fs::read(got).unwrap(), b"a picture, in words");
    // And one made on the laptop (its drawer sent it) reaches the desktop's Duck.
    let up = crate::assistant::attachments::store_bytes(&lap_files, "notes.txt", b"from the laptop").unwrap();
    desktop.fetch_attachment(&up.id, "notes.txt").await.unwrap();
    assert!(crate::assistant::attachments::file_of(&desk_files, &up.id, "notes.txt").is_ok());
    // One nobody has: a plain reason.
    let err = laptop.fetch_attachment("0123456789abcdef0123456789abcdef", "nope.txt").await.unwrap_err();
    assert!(err.contains("no machine sent it"), "{err}");
}

fn holder(f: &Fleet) -> (u64, Option<String>) {
    let c = f.status().config;
    (c.lease_term, c.duck)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_lease_moves_by_handover_and_failover() {
    let ok = Arc::new(AtomicBool::new(false));
    // The laptop alone: it takes Duck at once.
    let laptop = instance("laptop", ok.clone());
    let l = laptop.status().me.id;
    until("the laptop holds", || holder(&laptop) == (1, Some(l.clone()))).await;
    // A fleet that's been through a few terms (the desktop, new, starts at 1).
    laptop.take_lease(None).unwrap();
    assert_eq!(holder(&laptop), (2, Some(l.clone())));

    // Duck's state on the laptop, and a copy kept on the desktop.
    let (lap_db, lap_repl) = duck_files("laptop");
    let (_desk_db, desk_repl) = duck_files("desktop");
    lap_db.lock().unwrap().execute("INSERT INTO assistant_threads VALUES ('t1', 'on the laptop', 1)", []).unwrap();
    laptop.set_duck(lap_repl);
    let desktop = instance("desktop", ok.clone());
    desktop.set_duck(desk_repl);
    let promoted = Arc::new(std::sync::Mutex::new(Vec::<(u64, Option<[String; 2]>)>::new()));
    let p = promoted.clone();
    desktop.on_promote(Box::new(move |term, dirs| {
        p.lock().unwrap().push((term, dirs));
        Ok(())
    }));
    let d = desktop.status().me.id;
    let code = join_string(&laptop).await;
    desktop.join(&code).await.unwrap();

    // The desktop is first in the list: once up a while with its copy caught up,
    // it asks, and the laptop hands over.
    until("the desktop holds", || holder(&desktop) == (3, Some(d.clone())) && holder(&laptop) == (3, Some(d.clone()))).await;
    {
        let p = promoted.lock().unwrap();
        assert_eq!(p.len(), 1, "it took over with the laptop's copy");
        assert_eq!(p[0].0, 3);
        assert!(p[0].1.is_some(), "with the laptop's folders to rebase from");
    }

    // A server joins; the desktop goes away: the server is next, and takes over.
    let server = instance("server", ok.clone());
    let (_srv_db, srv_repl) = duck_files("server");
    server.set_duck(srv_repl);
    let s = server.status().me.id;
    let code = join_string(&desktop).await;
    server.join(&code).await.unwrap();
    until("the server follows", || holder(&server) == (3, Some(d.clone()))).await;
    desktop.set_offline(true);
    until("failover to the server", || holder(&server) == (4, Some(s.clone())) && holder(&laptop) == (4, Some(s.clone()))).await;

    // The desktop comes back: it follows the new term, then takes Duck back.
    desktop.set_offline(false);
    until("the desktop is back", || holder(&desktop).0 >= 4).await;
    until("handed back to the desktop", || {
        holder(&desktop) == (5, Some(d.clone())) && holder(&server) == (5, Some(d.clone())) && holder(&laptop) == (5, Some(d.clone()))
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pin_keeps_duck_where_it_is() {
    let ok = Arc::new(AtomicBool::new(false));
    let laptop = instance("laptop", ok.clone());
    let desktop = instance("desktop", ok.clone());
    let code = join_string(&laptop).await;
    desktop.join(&code).await.unwrap();
    until("linked", || online(&laptop, "desktop")).await;
    let l = laptop.status().me.id;
    laptop.set_pin(Some(l.clone())).unwrap();
    // Pinned to the laptop: the desktop, first in the list otherwise, never asks.
    until("pinned", || desktop.status().config.pin.is_some()).await;
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(holder(&desktop).1, Some(l.clone()));
    assert_eq!(holder(&laptop).1, Some(l));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn what_a_cut_off_main_wrote_is_merged_when_it_comes_back() {
    let ok = Arc::new(AtomicBool::new(false));
    let desktop = instance("desktop", ok.clone());
    let server = instance("server", ok.clone());
    let (desk_db, desk_repl) = duck_files_with("desktop", REAL_THREADS);
    let (srv_db, srv_repl) = duck_files_with("server", REAL_THREADS);
    desktop.set_duck(desk_repl);
    server.set_duck(srv_repl);
    let notices = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let n = notices.clone();
    server.on_merged(Box::new(move |t| n.lock().unwrap().push(t)));
    // What the server installs when it takes over: in the app, its copy of the
    // desktop's database (here its own stands in for it, with the copy's rows).
    let copy_into = srv_db.clone();
    server.on_promote(Box::new(move |_, _| {
        let c = copy_into.lock().unwrap();
        c.execute_batch("INSERT OR IGNORE INTO assistant_threads VALUES ('t', 'groceries', 'assistant', 1, 1, 0);
                         INSERT OR IGNORE INTO assistant_messages VALUES ('t', 1, 1, 'user', 'milk', NULL);")
            .map_err(|e| e.to_string())
    }));
    desk_db.lock().unwrap().execute_batch("INSERT INTO assistant_threads VALUES ('t', 'groceries', 'assistant', 1, 1, 0);
                                           INSERT INTO assistant_messages VALUES ('t', 1, 1, 'user', 'milk', NULL);").unwrap();
    let code = join_string(&desktop).await;
    server.join(&code).await.unwrap();
    let (d, s) = (desktop.status().me.id, server.status().me.id);
    until("the desktop holds, the server has its copy", || {
        holder(&server).1.as_deref() == Some(d.as_str())
            && server.status().replica.is_some_and(|r| r.seq > 0 && r.seq >= r.head)
    })
    .await;

    // Cut off, the desktop goes on: Duck answers there, in the same thread.
    desktop.set_offline(true);
    desk_db.lock().unwrap().execute_batch("INSERT INTO assistant_messages VALUES ('t', 2, 2, 'user', 'and eggs', NULL);
                                           INSERT INTO assistant_threads VALUES ('n', 'made apart', 'assistant', 2, 2, 0);
                                           INSERT INTO assistant_messages VALUES ('n', 1, 2, 'user', 'remember this', NULL);").unwrap();
    until("the server took over", || holder(&server) == (holder(&desktop).0 + 1, Some(s.clone()))).await;
    // Meanwhile the server answers in that thread too.
    srv_db.lock().unwrap().execute("INSERT INTO assistant_messages VALUES ('t', 2, 2, 'user', 'and bread', NULL)", []).unwrap();
    // Keep Duck on the server for the rest (no handover back mid-test).
    server.set_pin(Some(s.clone())).unwrap();

    desktop.set_offline(false);
    until("merged", || !notices.lock().unwrap().is_empty()).await;
    let c = srv_db.lock().unwrap();
    let rows = |sql: &str| -> Vec<String> { c.prepare(sql).unwrap().query_map([], |r| r.get(0)).unwrap().map(|x| x.unwrap()).collect() };
    assert_eq!(rows("SELECT content FROM assistant_messages WHERE thread_id = 't' ORDER BY seq"), ["milk", "and bread"]);
    assert_eq!(rows("SELECT content FROM assistant_messages WHERE thread_id = 'n'"), ["remember this"]);
    // The desktop's side of the thread both wrote to: a fork.
    assert_eq!(rows("SELECT content FROM assistant_messages WHERE thread_id LIKE 't~%' ORDER BY seq"), ["milk", "and eggs"]);
    let note = notices.lock().unwrap()[0].clone();
    assert!(note.contains("desktop"), "{note}");
    assert!(merge::split(&c).unwrap().is_none(), "merged once, then the mark is gone");
}
