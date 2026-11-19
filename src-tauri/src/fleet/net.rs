//! The fleet's network facts from Tailscale (fleet plan F1.1): this machine's tailnet
//! address (the remote server's detection), its MagicDNS name, and whether a peer's
//! address belongs to the same tailnet user (`tailscale whois`).

use std::net::IpAddr;

use super::proto;
use super::Net;
use crate::remote::funnel;

pub struct Tailscale;

fn cli_json(args: &[&str]) -> Result<serde_json::Value, String> {
    let cli = funnel::find_cli().ok_or("the tailscale command isn’t installed")?;
    funnel::run_json(&cli, args)
}

/// The LAN interface Wake-on-LAN reaches this machine on (F4.1).
pub fn local_lan() -> Option<super::proto::Lan> {
    let nets = sysinfo::Networks::new_with_refreshed_list();
    let mut list = Vec::new();
    for (name, n) in nets.iter() {
        for ip in n.ip_networks() {
            if let std::net::IpAddr::V4(addr) = ip.addr {
                list.push(super::proto::Interface { name: name.clone(), mac: n.mac_address().0, addr, prefix: ip.prefix });
            }
        }
    }
    super::proto::pick_lan(&list)
}

/// Send the magic packet to `broadcast` and to everyone, on the usual port (9).
pub fn send_magic(mac: [u8; 6], broadcast: std::net::Ipv4Addr) -> Result<(), String> {
    send_magic_to(mac, std::net::SocketAddr::from((broadcast, 9)))?;
    // The limited broadcast too: a router may drop the directed one.
    let _ = send_magic_to(mac, std::net::SocketAddr::from((std::net::Ipv4Addr::BROADCAST, 9)));
    Ok(())
}

fn send_magic_to(mac: [u8; 6], to: std::net::SocketAddr) -> Result<(), String> {
    let socket = std::net::UdpSocket::bind(("0.0.0.0", 0)).map_err(|e| e.to_string())?;
    socket.set_broadcast(true).map_err(|e| e.to_string())?;
    socket
        .send_to(&super::proto::magic_packet(mac), to)
        .map_err(|e| format!("couldn’t send the packet: {e}"))?;
    Ok(())
}


impl Net for Tailscale {
    fn tailnet_ip(&self) -> Option<IpAddr> {
        crate::remote::tailscale_ip().map(IpAddr::V4)
    }

    fn dns_name(&self) -> Option<String> {
        funnel::parse_status(&cli_json(&["status", "--json"]).ok()?).host
    }

    fn same_owner(&self, ip: IpAddr) -> Result<(), String> {
        let mine = proto::own_user(&cli_json(&["status", "--json"])?)
            .ok_or("Tailscale didn’t say who owns this machine")?;
        let whois = cli_json(&["whois", "--json", &ip.to_string()])
            .map_err(|e| format!("Tailscale doesn’t know {ip}: {e}"))?;
        match proto::whois_user(&whois) {
            Some(theirs) if theirs == mine => Ok(()),
            Some(_) => Err(format!("{ip} belongs to another tailnet user")),
            None => Err(format!("{ip} is a tagged machine, not one of yours")),
        }
    }

    fn lan(&self) -> Option<super::proto::Lan> {
        local_lan()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_packet_goes_out_on_a_socket() {
        let rx = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        rx.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
        let mac = [1, 2, 3, 4, 5, 6];
        super::send_magic_to(mac, rx.local_addr().unwrap()).unwrap();
        let mut buf = [0u8; 200];
        let (n, _) = rx.recv_from(&mut buf).unwrap();
        assert_eq!(&buf[..n], super::super::proto::magic_packet(mac).as_slice());
    }
}
