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
}
