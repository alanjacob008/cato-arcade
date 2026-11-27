process.env.CLAW_VRF_EXECUTION = "er";
try { await import("./vrf-devnet-server.mjs"); }
catch(error) { console.error(/^[a-z_]+$/.test(error.message)?error.message:"claw_backend_startup_failed_check_private_configuration");process.exit(1); }
