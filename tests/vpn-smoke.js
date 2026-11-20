const vpn = require("../extension/vpn.js");

(async () => {
  const probes = await vpn.probeExitAll();
  console.log("probes:", probes);
  console.log("fresh:", await vpn.probeExitFresh());
  const target = probes[0] && probes[0].ip;
  console.log("geo:", target ? await vpn.lookupGeo(target) : null);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
