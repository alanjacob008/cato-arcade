/* global solanaWeb3 */
(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get("session");
  const byId = id => document.getElementById(id);
  let current, provider, working = false, refreshing = false;
  const status = text => { byId("status").textContent = text; };
  const error = value => {
    const message = String(value?.message ?? value ?? "");
    const descriptions = {
      insufficient_devnet_sol_for_upgrade_peak: "Add devnet SOL before starting: the wallet must cover both the refundable upload buffer and additional program storage at the same time. See the verified rent quote in docs/claw/devnet-setup.md.",
      devnet_rpc_rate_limited: "The devnet RPC is rate limited. Wait a few seconds, then resume the upload. Confirmed chunks are preserved.",
      devnet_rpc_unavailable: "The devnet RPC is temporarily unavailable. Refresh status before resuming.",
      blockhash_expired_retry_same_step: "The signing window expired. Resume the upload to sign only the remaining chunks.",
      nonce_consumed_refresh_same_step: "This approval was already used or its nonce changed. Refresh status and resume the same step.",
      program_slot_pending_retry_same_step: "Solana is still processing the program storage change. Wait a moment, then resume the upgrade. Uploaded chunks are preserved.",
      wallet_changed_message: "The wallet returned different transaction contents. Nothing was broadcast. Refresh status and share the signing diagnostic below.",
      wallet_signature_missing: "The wallet returned a transaction without every required signature. Nothing was broadcast.",
      wallet_signature_invalid: "A returned transaction signature did not verify. Nothing was broadcast.",
    };
    byId("error").textContent = descriptions[message] ?? message.replaceAll("_", " ");
  };
  async function api(path, body) {
    if (!token) throw Error("Open the signing URL printed by the local server.");
    const response = await fetch(`/api/${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw Error(data.error ?? "Local request failed.");
    return data;
  }
  function controls() {
    const funding=current?.sponsorship;
    byId("topup-status").textContent=funding?.enabled
      ? `Vault ${funding.vault??"not ready"} · fee wallet ${funding.keeper??"not ready"} · ${((funding.balanceLamports??0)/1e9).toFixed(6)} devnet SOL · ${funding.alert??(funding.pending?"Refill pending":"Monitoring")}`
      : "Disabled until the separate sponsorship vault is configured.";
    const connected = provider?.publicKey?.toBase58() === current?.authority;
    byId("deploy").disabled = working || !connected || current?.deployed;
    byId("test").disabled = working || !connected || !current?.deployed || current?.execution === "er";
    byId("sponsor").disabled = working || !connected || !current?.deployed || current?.sponsor?.ready;
    byId("revoke-sponsor").disabled = working || !connected || !current?.deployed || (current?.execution === "er" ? current?.sponsor?.phase !== "delegated" || current?.sponsor?.pending : !current?.sponsor?.remaining);
    byId("connect").disabled = working;
    byId("refresh").disabled = working;
    byId("cashier-section").hidden=!current?.cashier;
    byId("cashier").disabled=working||!connected||!current?.deployed||!current?.cashier?.supported||current?.cashier?.ready;
    if(current?.cashier)byId("cashier-status").textContent=current.cashier.ready
      ? `Ready · vault ${current.cashier.vault} · settlement signer ${current.cashier.signer}`
      : `${current.cashier.supported?current.cashier.error??"Setup required":"Contract upgrade required"} · settlement signer ${current.cashier.signer}`;
    renderPool();
  }
  function renderPool() {
    const section=byId("pool-section");section.hidden=!current?.pool;
    if(!current?.pool)return;
    byId("pool-title").textContent="3. Concurrent sessions & automatic renewal";
    const connected=provider?.publicKey?.toBase58()===current.authority;
    byId("pool-summary").textContent=!current.poolSupported||!current.deployed?"Contract upgrade required before pool setup."
      :`${current.pool.occupied} of ${current.pool.size} sessions occupied · ${current.pool.remaining} authorized requests available today. ${current.pool.enabled?"Pool enabled.":"Pool activates after its first session is delegated."}`;
    const rows=current.pool.lanes.map(lane=>{
      const row=document.createElement("section"),title=document.createElement("h3"),data=document.createElement("p");
      title.textContent=lane.id;
      data.textContent=`${lane.phase}${lane.paused?" · paused":""} · ${lane.pending?"draw pending":"idle"} · ${lane.remaining} today left · ${Math.max(0,(lane.totalLimit??0)-(lane.usedTotal??0))} lifetime left · ${lane.renewals??0} renewals · ${lane.balanceSol.toFixed(6)} SOL`;
      row.append(title,data);
      for(const [action,label,disabled] of [
        ["plan",lane.phase==="delegate"?"Delegate session":lane.phase==="update"?"Authorize next policy":"Authorize session",lane.phase==="delegated"||lane.phase==="unavailable"],
        ["pause","Pause",lane.phase!=="delegated"||lane.paused],
        ["return","Return to Solana",lane.phase!=="delegated"||!lane.paused||lane.pending],
      ]){
        const button=document.createElement("button");button.type="button";button.textContent=label;
        button.disabled=working||!connected||!current.deployed||!current.poolSupported||disabled;
        button.onclick=()=>run(async()=>{
          const plan=await api("pool/"+action,{lane:lane.index});if(!plan.done)await approve(plan);
          await refresh();status(plan.description??"Pool action submitted. Refresh to verify its status.");
        });row.append(button);
      }
      return row;
    });
    byId("pool-lanes").replaceChildren(...rows);
  }
  function receiptLink(signature, text) {
    const link = document.createElement("a"); link.textContent = text; link.href = `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
    link.target = "_blank"; link.rel = "noreferrer noopener"; return link;
  }
  async function refresh() {
    current = await api("state");
    byId("authority").textContent = current.authority; byId("program").textContent = current.program;
    byId("checksum").textContent = current.sha256; byId("balance").textContent = `${current.balanceSol.toFixed(6)} SOL`;
    byId("rpc").textContent = current.rpcProvider;
    const er = current.execution === "er";
    byId("page-title").textContent = er ? "CATO · rollup VRF test" : "CATO VRF test";
    byId("test-section").hidden = er;
    byId("sponsor-title").textContent = er ? "2. Set up rollup session" : "3. CATO-sponsored gameplay";
    byId("sponsor-description").textContent = er
      ? "Initialize 500 diagnostic requests for 6 hours, then delegate the isolated session to MagicBlock’s Asia devnet validator. A separate test signer receives up to 0.005 devnet SOL. No treasury, payment or withdrawal access."
      : "Authorize a separate server signer for 500 devnet requests over 6 hours, topping its balance up to 0.05 devnet SOL. CATO covers the fees.";
    byId("sponsor").textContent = er ? current.sponsor?.phase === "delegate" ? "Delegate rollup session" : current.sponsor?.phase === "renew" ? "Renew 500 requests" : "Initialize rollup session" : "Authorize & fund sponsor";
    byId("revoke-sponsor").textContent = er ? "Return session to devnet" : "Revoke sponsor";
    byId("sponsor-status").textContent = current.sponsor ? `${current.sponsor.address} · ${current.sponsor.balanceSol.toFixed(6)} devnet SOL · ${current.sponsor.remaining} requests remaining${current.sponsor.expiresAt ? ` · expires ${new Date(current.sponsor.expiresAt * 1000).toLocaleString()}` : " · not authorized"}` : "Sponsor unavailable";
    byId("uploader").textContent = current.uploadSigner;
    byId("nonce").textContent = current.nonceReady ? "Ready—final deployment and test approvals do not have a short blockhash deadline" : "Prepared automatically after uploader authorization";
    byId("signing-diagnostic").textContent = current.lastSigningFailure ? JSON.stringify(current.lastSigningFailure, null, 2) : "";
    byId("signing-diagnostic").hidden = !current.lastSigningFailure;
    byId("play-link").hidden = !current.deployed || !(current.pool?.ready||current.sponsor?.ready);
    byId("play-link").href = current.hosted?new URL("/claw/play",current.playerOrigin).href:"/claw/play";
    byId("play-link").textContent="Open player preview";
    byId("deploy").textContent = current.uploading ? "Uploading automatically…" : current.missingChunks !== null ? "Resume upload & upgrade" : "Upload & upgrade";
    const done = current.deployed ? current.totalChunks : current.missingChunks === null ? 0 : current.totalChunks - current.missingChunks;
    byId("upload").value = done / current.totalChunks * 100;
    byId("progress-text").textContent = current.deployed ? "Verified deployed binary and wallet upgrade authority." : `${done} / ${current.totalChunks} binary chunks match onchain.`;
    byId("results").replaceChildren(...current.attempts.map(attempt => {
      const li = document.createElement("li");
      const outcome = attempt.callbackSignature ? `verified callback · ${attempt.result.success ? "win" : "miss"} · roll ${attempt.result.roll}` : attempt.result?.status ?? "not submitted";
      li.append(`${attempt.count} boxes · ${Number(attempt.threshold) / 2 ** 32 * 100}% · ${outcome} `);
      if (attempt.requestSignature) li.append(receiptLink(attempt.requestSignature, "Request"), " ");
      if (attempt.callbackSignature) li.append(receiptLink(attempt.callbackSignature, "Callback"));
      return li;
    }));
    byId("checks").textContent = current.negativeChecks.length ? "Unauthorized callback identities and duplicate nonce rejected in simulation; fulfilled account unchanged." : "";
    controls(); return current;
  }
  const from64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
  const to64 = bytes => btoa(String.fromCharCode(...bytes));
  async function approve(plan) {
    if (!provider?.isPhantom || provider.publicKey?.toBase58() !== current.authority || plan.authority !== current.authority || plan.cluster !== "devnet") throw Error("Connect the required Phantom wallet.");
    status(plan.description + (plan.lifetime === "durable-nonce" ? " This approval has no short blockhash deadline. Approve in Phantom." : " Approve in Phantom."));
    const transactions = plan.transactions.map(value => solanaWeb3.VersionedTransaction.deserialize(from64(value)));
    const signed = transactions.length === 1 ? [await provider.signTransaction(transactions[0])]
      : await provider.signAllTransactions(transactions);
    if (provider.publicKey?.toBase58() !== current.authority) throw Error("Wallet changed. Reconnect before continuing.");
    status("Sending approved transactions to devnet and waiting for confirmation…");
    return api("submit", { id: plan.id, transactions: signed.map(tx => to64(tx.serialize())) });
  }
  async function run(action) {
    if (working) return;
    working = true; controls(); error("");
    try { await action(); }
    catch (value) { error(value); status("Stopped. Refresh status before retrying; confirmed chunks and locked requests are preserved."); }
    finally { working = false; try { await refresh(); } catch (value) { error(value); } controls(); }
  }
  byId("connect").onclick = () => run(async () => {
    provider = window.phantom?.solana;
    if (!provider?.isPhantom) throw Error("Open this page in the browser where the Phantom extension is installed.");
    await provider.connect();
    if (provider.publicKey.toBase58() !== current.authority) throw Error(`Select the required ${current.authority.slice(0, 5)}…${current.authority.slice(-4)} account in Phantom, then connect again.`);
    byId("wallet").textContent = `Connected: ${provider.publicKey.toBase58()}`;
    status("Phantom connected. All broadcasts use devnet.");
  });
  byId("deploy").onclick = () => run(async () => {
    for (let step = 0; step < 300; step++) {
      const plan = await api("deploy", { resume: step === 0 });
      if (plan.done) { status("Deployment verified. Ready to test MagicBlock callbacks."); return; }
      if (plan.waiting) {
        status(plan.description + ". No Phantom signatures are needed for individual chunks.");
        await new Promise(resolve => setTimeout(resolve, 3000)); await refresh();
        if (current.uploadError) throw Error(current.uploadError);
        continue;
      }
      await approve(plan); await refresh();
    }
    throw Error("Upload step limit reached. Refresh to resume.");
  });
  async function waitForCallback(nonce) {
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 3000)); await refresh();
      const locked = current.attempts.find(item => item.nonce === nonce);
      if (locked?.callbackSignature) return;
      status("Waiting for the locked MagicBlock callback. No replacement randomness will be used.");
    }
    throw Error("Callback is still pending. Refresh later; do not create a replacement attempt.");
  }
  byId("test").onclick = () => run(async () => {
    await refresh();
    const pending = current.attempts.at(-1);
    if (pending?.requestSignature && !pending.callbackSignature) await waitForCallback(pending.nonce);
    for (const count of [64, 128]) for (const threshold of ["0", "2147483648", "4294967296"]) {
      if (current.attempts.some(item => item.count === count && item.threshold === threshold && item.callbackSignature)) continue;
      const plan = await api("probe", { count, threshold }); await approve(plan); await refresh();
      await waitForCallback(current.attempts.at(-1).nonce);
    }
    status("Checking unauthorized callbacks and duplicate requests in simulation…");
    await api("negative-checks", {}); await refresh();
    status("Six onchain callbacks verified. Negative checks passed. Diagnostic VRF wiring is working.");
  });
  byId("refresh").onclick = () => run(async () => { await refresh(); status("Devnet status refreshed."); });
  byId("sponsor").onclick = () => run(async () => { const plan = await api("sponsor/plan", {}); if (!plan.done) await approve(plan); await refresh(); status(current.sponsor?.ready ? "Sponsor ready. Open the claw timing test; no per-drop wallet signatures are needed." : current.sponsor?.phase === "delegate" ? "Session initialized. Click Delegate rollup session for the second approval." : "Session setup is confirming. Refresh status shortly."); });
  byId("revoke-sponsor").onclick = () => run(async () => { const plan = await api("sponsor/revoke", {}); if (!plan.done) await approve(plan); await refresh(); status(plan.description ?? "New sponsored requests are blocked. Existing callbacks can finish."); });
  byId("cashier").onclick=()=>run(async()=>{const plan=await api("cashier/plan",{});if(!plan.done)await approve(plan);await refresh();status(current.cashier?.ready?"Cashier ready. Fund the displayed vault ATA with devnet USDC before testing payouts.":"Setup approval confirmed. Repeat initialization if the nonce was just created.");});
  refresh().then(async () => {
    provider = window.phantom?.solana;
    if (provider?.isPhantom) {
      try {
        await provider.connect({ onlyIfTrusted: true });
        if (provider.publicKey?.toBase58() === current.authority) byId("wallet").textContent = `Connected: ${provider.publicKey.toBase58()}`;
      } catch { /* A new wallet connection still requires the Connect button. */ }
    }
    controls(); status(provider?.publicKey?.toBase58() === current.authority ? "Phantom connected. Resume the confirmed upload." : "Select the funded account in Phantom, then connect.");
  }).catch(error);
  setInterval(async () => { if (working || refreshing || document.hidden) return; refreshing = true; try { await refresh(); } catch (value) { error(value); } finally { refreshing = false; } }, 10000);
})();
