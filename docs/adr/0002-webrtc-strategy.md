# WebRTC strategy: filter candidates, do not force relay

WebRTC keeps `disable_non_proxied_udp` and filters host/mDNS candidates, leaving only srflx/relay candidates, instead of forcing `iceTransportPolicy="relay"`. Forced relay broke calls whenever no TURN server was available and did not address the actual local-network leak; srflx through the proxy is consistent with the Persona because it exposes the VPN exit IP. A strict-relay toggle remains for users who prefer leak protection over call compatibility.
