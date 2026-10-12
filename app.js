(() => {
  const cfg = window.BPC_CONFIG || {};
  const configReady = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
    !cfg.SUPABASE_URL.includes("PASTE_") && !cfg.SUPABASE_ANON_KEY.includes("PASTE_");
  const client = configReady ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
  const $ = id => document.getElementById(id);
  const state = {
  session:null,
  profile:null,
  player:null,
  isAdmin:false,
  signup:false,
  recoveryMode:false,
  members:[],
  registeredPlayers:[]
};
  const monthNow = new Date().toISOString().slice(0,7);
  $("monthPicker").value = monthNow;
  $("historyMonth").value = monthNow;
  $("matchDate").value = new Date().toISOString().slice(0,10);

  function toast(msg){const t=$("toast");t.textContent=msg;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),3200);}
  function status(id,msg,type=""){const el=$(id);if(!el)return;el.textContent=msg;el.className="status "+type;}
  function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
  function monthDate(v){return v ? v+"-01" : new Date().toISOString().slice(0,10);}
  function prettyDate(v){if(!v)return "—";const d=new Date(v+"T12:00:00");return d.toLocaleDateString(undefined,{day:"2-digit",month:"short",year:"numeric"});}
  function showView(name){
    document.querySelectorAll(".view").forEach(v=>v.classList.add("hidden"));
    const target=$("view-"+name);if(target)target.classList.remove("hidden");
    document.querySelectorAll(".navlink").forEach(b=>b.classList.toggle("active",b.dataset.view===name));
    $("nav").classList.remove("open");
    if(name==="home"){loadLeaderboard();loadPublicPoster();}
    if(name==="history")loadHistory();
    if(name==="admin")loadAdmin();
    if(name==="profile")loadProfile();
    window.scrollTo({top:0,behavior:"smooth"});
  }
  document.querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.view)));
  $("menuBtn").addEventListener("click",()=>$("nav").classList.toggle("open"));
  $("monthPicker").addEventListener("change",loadLeaderboard);
  $("refreshLeaderboard").addEventListener("click",loadLeaderboard);
  $("historyMonth").addEventListener("change",loadHistory);
  $("refreshHistory").addEventListener("click",loadHistory);
  $("refreshPending").addEventListener("click",loadAdmin);
  $("toggleAllMatchHistory").addEventListener("click",async()=>{
    const panel=$("allMatchHistoryPanel");
    const opening=panel.classList.contains("hidden");
    panel.classList.toggle("hidden",!opening);
    $("toggleAllMatchHistory").textContent=opening?"Hide all match history":"Show all match history";
    if(opening)await loadAllMatchHistory();
  });
  $("refreshAllMatchHistory").addEventListener("click",loadAllMatchHistory);

  if(!configReady){
    status("leaderboardStatus","Setup required: open config.js and paste your Supabase Project URL and anon/public key.","error");
    $("leaderboardBody").innerHTML='<tr><td colspan="12" class="empty">Complete the setup steps in README.md to connect the database.</td></tr>';
    $("authSubmit").disabled=true;$("matchSubmit").disabled=true;
  }

  async function loadPublicPoster(){
    if(!client)return;
    const {data,error}=await client.from("site_posters").select("id,title,image_path,published_at,expires_at").eq("is_active",true).lte("published_at",new Date().toISOString()).gt("expires_at",new Date().toISOString()).order("published_at",{ascending:false}).limit(1);
    const section=$("uclPosterSection");
    if(error||!data||!data.length){section.classList.add("hidden");return;}
    const p=data[0];
    $("posterTitle").textContent=p.title||"UCL Finalists";
    $("posterImage").src=client.storage.from("bpc-posters").getPublicUrl(p.image_path).data.publicUrl;
    $("posterCaption").textContent="Featured until "+new Date(p.expires_at).toLocaleString();
    section.classList.remove("hidden");
  }

  async function loadPosterAdmin(){
    if(!client||!state.isAdmin)return;
    const box=$("posterAdminList");
    const {data,error}=await client.from("site_posters").select("id,title,image_path,published_at,expires_at,is_active").order("created_at",{ascending:false}).limit(20);
    if(error){status("posterAdminStatus",error.message,"error");return;}
    if(!data?.length){box.innerHTML='<div class="panel soft">No posters published yet.</div>';return;}
    box.innerHTML=data.map(p=>'<article class="poster-admin-item"><div><b>'+esc(p.title)+'</b><p class="small">'+(p.is_active?"Active":"Removed")+' · Expires '+new Date(p.expires_at).toLocaleString()+'</p></div>'+(p.is_active?'<button class="reject-btn" data-remove-poster="'+esc(p.id)+'">Remove now</button>':'<span class="pill">Inactive</span>')+'</article>').join("");
    box.querySelectorAll("[data-remove-poster]").forEach(b=>b.addEventListener("click",()=>deactivatePoster(b.dataset.removePoster)));
  }

  async function deactivatePoster(id){
    if(!state.isAdmin)return;
    const {error}=await client.from("site_posters").update({is_active:false}).eq("id",id);
    if(error){status("posterAdminStatus",error.message,"error");return;}
    status("posterAdminStatus","Poster removed from the website.","success");
    await loadPosterAdmin();await loadPublicPoster();
  }

  $("posterForm").addEventListener("submit",async e=>{
    e.preventDefault();
    if(!state.isAdmin||!state.session)return;
    const file=$("posterFile").files?.[0];
    const title=$("posterUploadTitle").value.trim()||"UCL Finalists";
    if(!file){status("posterAdminStatus","Choose an image first.","error");return;}
    if(file.size>8*1024*1024){status("posterAdminStatus","Image must be 8 MB or smaller.","error");return;}
    if(!["image/jpeg","image/png","image/webp","image/gif"].includes(file.type)){status("posterAdminStatus","Please choose a JPG, PNG, WEBP, or GIF image.","error");return;}
    const btn=$("publishPosterBtn");btn.disabled=true;status("posterAdminStatus","Uploading image…");
    const path="posters/"+Date.now()+"-"+file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
    try{
      const up=await client.storage.from("bpc-posters").upload(path,file,{contentType:file.type,upsert:false});
      if(up.error)throw up.error;
      const {error:oldError}=await client.from("site_posters").update({is_active:false}).eq("is_active",true);
      if(oldError)throw oldError;
      const {error:insertError}=await client.from("site_posters").insert({title,image_path:path,is_active:true,created_by:state.session.user.id,expires_at:new Date(Date.now()+72*60*60*1000).toISOString()});
      if(insertError)throw insertError;
      $("posterFile").value="";status("posterAdminStatus","Poster published for 3 days.","success");
      await loadPosterAdmin();await loadPublicPoster();
    }catch(err){status("posterAdminStatus",err.message||"Could not publish poster.","error");}
    finally{btn.disabled=false;}
  });

  function setAuthUI(){
    if(state.recoveryMode){
      $("accountNav").textContent="Reset password";
      document.querySelectorAll(".auth-only,.admin-only").forEach(x=>x.classList.add("hidden"));
      $("historySignIn").classList.remove("hidden");
      $("historyContent").classList.add("hidden");
      $("authTitle").textContent="Choose a new password";
      $("authForm").innerHTML='<label>New password<input id="newRecoveryPassword" type="password" minlength="8" autocomplete="new-password" required placeholder="At least 8 characters"></label><label>Confirm new password<input id="confirmRecoveryPassword" type="password" minlength="8" autocomplete="new-password" required placeholder="Enter the password again"></label><button id="saveRecoveryPassword" class="primary" type="submit">Save new password</button><div id="recoveryMessage" class="status"></div>';
      $("authForm").onsubmit=async e=>{
        e.preventDefault();
        const password=$("newRecoveryPassword").value;
        if(password.length<8){status("recoveryMessage","Password must be at least 8 characters.","error");return;}
        if(password!==$("confirmRecoveryPassword").value){status("recoveryMessage","The passwords do not match.","error");return;}
        const btn=$("saveRecoveryPassword");btn.disabled=true;
        try{
          const {error}=await client.auth.updateUser({password});
          if(error)throw error;
          state.recoveryMode=false;
          history.replaceState(null,"",location.pathname+location.search);
          setAuthUI();
          toast("Password updated successfully.");
        }catch(err){status("recoveryMessage",err.message||"Could not update the password. Open the recovery email link again.","error");}
        finally{if($("saveRecoveryPassword"))$("saveRecoveryPassword").disabled=false;}
      };
      showView("account");
      return;
    }
    const signed=!!state.session;
    $("accountNav").textContent=signed?(state.profile?.display_name||"My account"):"Sign in";
    document.querySelectorAll(".auth-only").forEach(x=>x.classList.toggle("hidden",!signed));
    document.querySelectorAll(".admin-only").forEach(x=>x.classList.toggle("hidden",!state.isAdmin));
    $("historySignIn").classList.toggle("hidden",signed);
    $("historyContent").classList.toggle("hidden",!signed);
    if(signed){
      $("authTitle").textContent="You're signed in";
      $("authForm").innerHTML='<h3>Signed in as '+esc(state.profile?.display_name||state.session.user.email)+'</h3><p>Use the navigation to submit a match, view your history or open your dashboard.</p><button type="button" class="primary" id="openProfile">Open my dashboard</button><button type="button" class="secondary" id="signOutBtn" style="margin-left:8px">Sign out</button>';
      $("openProfile").onclick=()=>showView("profile");
      $("signOutBtn").onclick=signOut;
    } else {
      $("authTitle").textContent=state.signup?"Create your member account":"Welcome back";
      $("authForm").innerHTML=authFormMarkup();
      wireAuthForm();
    }
  }
  function authFormMarkup(){return '<label id="displayNameLabel" '+(state.signup?'':'class="hidden"')+'>Display name<input id="displayName" autocomplete="name" placeholder="Your player name" '+(state.signup?'required':'')+'></label><label>Email address<input id="email" type="email" autocomplete="email" required placeholder="you@example.com"></label><label>Password<input id="password" type="password" autocomplete="'+(state.signup?'new-password':'current-password')+'" minlength="8" required placeholder="At least 8 characters"></label><button id="authSubmit" class="primary" type="submit">'+(state.signup?'Create account':'Sign in')+'</button><button id="toggleAuth" class="text-button" type="button">'+(state.signup?'Already have an account? Sign in':'Need an account? Create one')+'</button><div id="authMessage" class="status"></div>';}
  function wireAuthForm(){
    $("authForm").onsubmit=async e=>{
      e.preventDefault();if(!client)return;
      const email=$("email").value.trim(),password=$("password").value;
      const btn=$("authSubmit");btn.disabled=true;
      try{
        let result;
        if(state.signup){
          const name=$("displayName").value.trim();if(!name)throw new Error("Please enter your player name.");
          result=await client.auth.signUp({email,password,options:{data:{display_name:name}}});
          if(result.error)throw result.error;
          status("authMessage","Account created. If email confirmation is enabled, check your inbox to confirm before signing in.","success");
          state.signup=false;
          if(result.data.session){state.session=result.data.session;await loadIdentity();setAuthUI();toast("Account created.");}
        }else{
          result=await client.auth.signInWithPassword({email,password});
          if(result.error)throw result.error;
          state.session=result.data.session;await loadIdentity();setAuthUI();toast("Welcome back.");
        }
      }catch(err){status("authMessage",err.message||String(err),"error");}
      finally{if($("authSubmit"))$("authSubmit").disabled=false;}
    };
    $("toggleAuth").onclick=()=>{state.signup=!state.signup;setAuthUI();};
  }
  async function signOut(){await client.auth.signOut();state.session=null;state.profile=null;state.player=null;state.isAdmin=false;setAuthUI();toast("Signed out.");showView("home");}
  async function loadIdentity(){
    if(!client||!state.session)return;
    const uid=state.session.user.id;
    const [pr,pl]=await Promise.all([
      client.from("profiles").select("*").eq("id",uid).maybeSingle(),
      client.from("players").select("*").eq("user_id",uid).maybeSingle()
    ]);
    state.profile=pr.data||{display_name:state.session.user.email,role:"player"};
    state.player=pl.data||null;state.isAdmin=state.profile.role==="admin";
    if(state.player&&!state.player.active)toast("Your player profile is inactive. Contact an admin.");
  }
  
async function loadMembers() {
  if (!client) return;

  const [membersResult, playersResult] = await Promise.all([
    client
      .from("cobeg_members")
      .select("id,name,active")
      .eq("active", true)
      .order("name"),

    client
      .from("active_player_directory")
      .select("id,display_name")
      .order("display_name")
  ]);

  if (membersResult.error) {
    console.error("Could not load COBEG XI members:", membersResult.error);
    toast("Could not load COBEG XI members.");
    return;
  }

  state.members = membersResult.data || [];

  if (playersResult.error) {
    console.error("Could not load registered players:", playersResult.error);
    toast("Could not load registered player suggestions.");
    return;
  }

  state.registeredPlayers = playersResult.data || [];

  // Populate the COBEG XI dropdown.
  const cobegSelect = $("cobegOpponent");
  cobegSelect.innerHTML =
    '<option value="">Choose COBEG XI member</option>';

  state.members.forEach(member => {
    const option = document.createElement("option");
    option.value = member.id;
    option.textContent = member.name;
    cobegSelect.appendChild(option);
  });

  // Compare first names without regard to case or extra spaces.
  function normalizeFirstName(name) {
    return (name || "")
      .trim()
      .split(/\s+/)[0]
      .toLowerCase();
  }

  const cobegFirstNames = new Set(
    state.members.map(member => normalizeFirstName(member.name))
  );

  // Exclude registered players whose first name matches a COBEG XI member.
  const otherPlayers = state.registeredPlayers.filter(player =>
    !cobegFirstNames.has(normalizeFirstName(player.display_name))
  );

  // Populate the Other opponent dropdown.
  const otherSelect = $("otherOpponent");

  if (otherSelect) {
    const previousValue = otherSelect.value;

    otherSelect.innerHTML =
      '<option value="">Choose registered player</option>';

    otherPlayers.forEach(player => {
      const option = document.createElement("option");
      option.value = player.display_name;
      option.textContent = player.display_name;
      otherSelect.appendChild(option);
    });

    if (
      previousValue &&
      otherPlayers.some(player => player.display_name === previousValue)
    ) {
      otherSelect.value = previousValue;
    }
  }
}
    
  $("opponentType").addEventListener("change",()=>{
 const isCobeg=$("opponentType").value==="cobeg";
 $("cobegOpponentLabel").classList.toggle("hidden",!isCobeg);
 $("otherOpponentLabel").classList.toggle("hidden",isCobeg);
 $("cobegOpponent").required=isCobeg;
 $("otherOpponent").required=!isCobeg;
});
  $("opponentType").dispatchEvent(new Event("change"));
  
$("matchForm").addEventListener("submit", async e => {
  e.preventDefault();

  if (!client || !state.session) {
    toast("Please sign in first.");
    showView("account");
    return;
  }

  if (!state.player || !state.player.active) {
    status(
      "matchMessage",
      "Your player profile is not active. Contact an admin.",
      "error"
    );
    return;
  }

  const type = $("opponentType").value;
  const member = state.members.find(
    m => m.id === $("cobegOpponent").value
  );

  const opponent = type === "cobeg"
    ? (member?.name || "")
    : $("otherOpponent").value;

  const date = $("matchDate").value;
  const pg = Number($("playerGoals").value);
  const og = Number($("opponentGoals").value);

  if (
    !opponent ||
    !date ||
    $("playerGoals").value.trim() === "" ||
    $("opponentGoals").value.trim() === "" ||
    !Number.isInteger(pg) ||
    !Number.isInteger(og) ||
    pg < 0 ||
    og < 0
  ) {
    status(
      "matchMessage",
      "Please select an opponent, choose a date, and enter valid scores.",
      "error"
    );
    return;
  }

  if (
    opponent.trim().toLowerCase() ===
    state.player.display_name.trim().toLowerCase()
  ) {
    status(
      "matchMessage",
      "You cannot submit yourself as your opponent.",
      "error"
    );
    return;
  }

  const btn = $("matchSubmit");
  btn.disabled = true;
  btn.textContent = "Submitting…";

  try {
    const { data, error } = await client.rpc("submit_match", {
      p_opponent_name: opponent,
      p_match_date: date,
      p_player_goals: pg,
      p_opponent_goals: og,
      p_notes: $("matchNotes").value,
      p_cobeg_member_id: type === "cobeg" ? member?.id ?? null : null
    });

    if (error) throw error;

    $("matchForm").reset();
    $("matchDate").value = new Date().toISOString().slice(0, 10);

    $("opponentType").dispatchEvent(
      new Event("change", { bubbles: true })
    );

    status(
      "matchMessage",
      "Result submitted successfully. It is now pending admin approval. Reference: " + data,
      "success"
    );

    toast("Result submitted for review.");
  } catch (err) {
    console.error("Match submission failed:", err);
    status(
      "matchMessage",
      err.message || "Submission failed. Please try again.",
      "error"
    );
  } finally {
    btn.disabled = false;
    btn.textContent = "Submit result";
  }
});

  async function loadLeaderboard(){
    if(!client)return;
    const month=$("monthPicker").value||monthNow;
    $("leaderboardMonthLabel").textContent=new Date(month+"-01T12:00:00").toLocaleDateString(undefined,{month:"long",year:"numeric"})+" leaderboard";
    status("leaderboardStatus","Loading rankings…");
    const {data,error}=await client.rpc("get_leaderboard",{p_month:monthDate(month)});
    if(error){status("leaderboardStatus",error.message,"error");return;}
    status("leaderboardStatus",data.length+" active players · Approved and counted results only.");
    const body=$("leaderboardBody");
    if(!data.length){body.innerHTML='<tr><td colspan="12" class="empty">No active players yet. Members can register to appear here.</td></tr>';return;}
    body.innerHTML=data.map(r=>'<tr><td class="'+(r.rank<=3?'rank-'+r.rank:'')+'">'+r.rank+'</td><td><div class="player-cell"><span class="avatar">'+esc((r.player_name||"?").split(/\s+/).map(x=>x[0]).slice(0,2).join("").toUpperCase())+'</span>'+esc(r.player_name)+'</div></td><td>'+r.matches_played+'</td><td>'+r.wins+'</td><td>'+r.draws+'</td><td>'+r.losses+'</td><td>'+r.goals_for+'</td><td>'+r.goals_against+'</td><td>'+signed(r.goal_difference)+'</td><td class="points">'+r.points+'</td><td>'+r.cobeg_opponents+'/5</td><td><span class="pill '+(r.award_eligible?'good':'')+'">'+(r.award_eligible?'Eligible':'In progress')+'</span></td></tr>').join("");
  }
  function signed(n){return n>0?"+"+n:n;}

  
async function loadHistory(){
  if(!client)return;

  if(!state.session){
    $("historySignIn").classList.remove("hidden");
    $("historyContent").classList.add("hidden");
    return;
  }

  $("historySignIn").classList.add("hidden");
  $("historyContent").classList.remove("hidden");
  status("historyStatus","Loading your history…");

  let q = client.from("matches")
    .select("id,player_id,opponent_name,match_date,player_goals,opponent_goals,result,points,status,counted,exclusion_reason,submitted_at")
    .order("match_date",{ascending:false})
    .order("submitted_at",{ascending:false})
    .limit(500);

  const month = $("historyMonth").value;
  if(month){
    const d1 = month + "-01";
    const d = new Date(d1 + "T12:00:00");
    d.setMonth(d.getMonth()+1);
    q = q.gte("match_date",d1).lt("match_date",d.toISOString().slice(0,10));
  }

  const {data,error} = await q;
  if(error){
    status("historyStatus",error.message,"error");
    return;
  }

  const matches = data || [];
  const playerIds = [...new Set(matches.map(m=>m.player_id))];
  const playerNames = {};

  if(playerIds.length){
    const {data:players,error:playersError} = await client
      .from("players")
      .select("id,display_name")
      .in("id",playerIds);

    if(playersError){
      status("historyStatus",playersError.message,"error");
      return;
    }

    (players || []).forEach(p=>{
      playerNames[p.id] = p.display_name;
    });
  }

  const myName = (state.player?.display_name || state.profile?.display_name || "")
    .trim().toLowerCase();

  // Personal history includes matches I submitted and matches submitted against me.
  const myPlayerId = state.player?.id || null;
  const personalMatches = matches.filter(m=>{
    const submittedName = (playerNames[m.player_id] || "").trim().toLowerCase();
    const opponentName = (m.opponent_name || "").trim().toLowerCase();
    return (myPlayerId && m.player_id === myPlayerId) ||
      submittedName === myName ||
      opponentName === myName;
  });

  const rows = personalMatches.map(m=>{
    const submittedName = (playerNames[m.player_id] || "").trim();
    const isOpponentView =
      submittedName.toLowerCase() !== myName &&
      (m.opponent_name || "").trim().toLowerCase() === myName;

    if(!isOpponentView){
      return {
        ...m,
        historyOpponent: m.opponent_name,
        historyPlayerGoals: m.player_goals,
        historyOpponentGoals: m.opponent_goals,
        historyResult: m.result,
        historyPoints: m.points
      };
    }

    
const myGoals = m.opponent_goals;
const theirGoals = m.player_goals;

const historyResult = myGoals > theirGoals
  ? "WIN"
  : myGoals < theirGoals
    ? "LOSS"
    : "DRAW";

const historyPoints = myGoals > theirGoals
  ? 3
  : myGoals === theirGoals
    ? 1
    : 0;

return {
  ...m,
  historyOpponent: submittedName,
  historyPlayerGoals: myGoals,
  historyOpponentGoals: theirGoals,
  historyResult,
  historyPoints
};
  });

  status("historyStatus",rows.length+" personal results in this view.");

  $("historyBody").innerHTML = rows.length
    ? rows.map(m=>
      '<tr><td>'+prettyDate(m.match_date)+'</td>'+
      '<td>'+esc(m.historyOpponent)+'</td>'+
      '<td><b>'+m.historyPlayerGoals+' – '+m.historyOpponentGoals+'</b></td>'+
      '<td>'+esc(m.historyResult)+'</td>'+
      '<td>'+(m.historyPoints ?? m.points)+'</td>'+
      '<td><span class="pill '+(m.status==="approved"?"good":m.status==="rejected"?"bad":"pending")+'">'+esc(m.status)+'</span></td>'+
      '<td><span class="pill '+(m.counted?"good":"")+'">'+(m.counted?"Yes":"No")+'</span></td></tr>'
    ).join("")
    : '<tr><td colspan="7" class="empty">No match results found for this month.</td></tr>';
}
  async function loadProfile(){
    if(!client||!state.session){showView("account");return;}
    $("profileHeading").textContent=(state.player?.display_name||"My")+" dashboard";
    const {data,error}=await client.rpc("get_my_month_stats",{p_month:monthDate($("monthPicker").value||monthNow)});
    if(error){$("profileStats").innerHTML='<div class="panel">'+esc(error.message)+'</div>';return;}
    const s=data?.[0];
    if(!s){$("profileStats").innerHTML="";return;}
    const vals=[["Matches",s.matches_played],["Wins",s.wins],["Draws",s.draws],["Losses",s.losses],["Goals for",s.goals_for],["Goals against",s.goals_against],["Goal difference",signed(s.goal_difference)],["Points",s.points]];
    $("profileStats").innerHTML=vals.map(x=>'<div class="stat-card"><small>'+x[0]+'</small><b>'+x[1]+'</b></div>').join("");
    $("eligibilityText").textContent=s.award_eligible?"You are currently eligible for the monthly award.":`You need at least 40 counted matches and 5 different COBEG XI opponents. Current progress: ${s.matches_played}/40 counted matches, ${s.cobeg_opponents}/5 COBEG XI opponents. Pending matches this month: ${s.pending_matches}.`;
  }

  async function loadAdmin(){
    if(!client||!state.session)return;
    await loadIdentity();
    $("adminDenied").classList.toggle("hidden",state.isAdmin);
    $("adminContent").classList.toggle("hidden",!state.isAdmin);
    if(!state.isAdmin)return;
    await loadPosterAdmin();
    status("adminStatus","Loading pending submissions…");
    const {data,error}=await client.from("matches").select("id,player_id,opponent_name,match_date,player_goals,opponent_goals,result,points,notes,submitted_at").eq("status","pending").order("submitted_at",{ascending:true}).limit(100);
    if(error){status("adminStatus",error.message,"error");return;}
    $("pendingCount").textContent=(data||[]).length+" pending";
    status("adminStatus","Review each result before approving.");
    const playerIds=[...new Set((data||[]).map(m=>m.player_id))];
    let players={};
    if(playerIds.length){const p=await client.from("players").select("id,display_name").in("id",playerIds);(p.data||[]).forEach(x=>players[x.id]=x.display_name);}
    $("pendingList").innerHTML=(data||[]).length?(data||[]).map(m=>'<article class="pending-card"><div><h3>'+esc(players[m.player_id]||"Player")+' <span class="muted">vs</span> '+esc(m.opponent_name)+'</h3><p>'+prettyDate(m.match_date)+' · Score <b>'+m.player_goals+' – '+m.opponent_goals+'</b> · '+m.result+' · '+m.points+' pts</p><p>'+esc(m.notes||"No notes")+'</p><small>Submitted '+new Date(m.submitted_at).toLocaleString()+'</small></div><div class="pending-actions"><button class="approve-btn" data-approve="'+m.id+'">Approve</button><button class="reject-btn" data-reject="'+m.id+'">Reject</button></div></article>').join(""):'<div class="panel soft">No pending submissions. All caught up!</div>';
    document.querySelectorAll("[data-approve]").forEach(b=>b.onclick=()=>reviewMatch(b.dataset.approve,true));
    document.querySelectorAll("[data-reject]").forEach(b=>b.onclick=()=>reviewMatch(b.dataset.reject,false));
    const members=await client.from("cobeg_members").select("id,name,active").order("name");
    state.members=members.data||[];
    $("memberList").innerHTML=state.members.map(m=>'<span class="member-chip">'+esc(m.name)+(m.active?'':' (inactive)')+'</span>').join("");
    

const ps = await client
  .from("players")
  .select("id,display_name,active,created_at")
  .order("created_at", { ascending: false })
  .limit(100);

if (ps.error) {
  status("adminStatus", ps.error.message, "error");
  return;
}

$("playersBody").innerHTML = (ps.data || []).map(p =>
  '<tr>' +
    '<td>' + esc(p.display_name) + '</td>' +
    '<td><span class="pill ' + (p.active ? 'good' : 'bad') + '">' +
      (p.active ? 'Active' : 'Inactive') +
    '</span></td>' +
    '<td>' + prettyDate(p.created_at?.slice(0, 10)) + '</td>' +
    '<td><button type="button" class="recovery-btn" data-recover="' +
      esc(p.id) + '">Recover Account</button></td>' +
  '</tr>'
).join("");
    $("playersBody").querySelectorAll("[data-recover]").forEach(button=>{
      button.onclick=()=>recoverPlayerAccount(button.dataset.recover,button);
    });
  }

  async function loadAllMatchHistory(){
    if(!client||!state.isAdmin)return;
    status("allMatchHistoryStatus","Loading all match records…");
    try{
      // Page through the full table so lineup sequence counts are not cut off at 1,000 rows.
      const pageSize=1000;
      let matches=[],from=0;
      while(true){
        const {data,error}=await client.from("matches")
          .select("id,player_id,opponent_name,match_date,player_goals,opponent_goals,result,points,status,counted,exclusion_reason,submitted_at,approved_at")
          .order("match_date",{ascending:false})
          .order("submitted_at",{ascending:false})
          .range(from,from+pageSize-1);
        if(error)throw error;
        const page=data||[];
        matches=matches.concat(page);
        if(page.length<pageSize)break;
        from+=pageSize;
      }
      const ids=[...new Set(matches.map(m=>m.player_id).filter(Boolean))];
      const names={};
      // Keep player-name lookups in safe-sized batches.
      for(let i=0;i<ids.length;i+=200){
        const batch=ids.slice(i,i+200);
        const {data:players,error}=await client.from("players").select("id,display_name").in("id",batch);
        if(error)throw error;
        (players||[]).forEach(p=>names[p.id]=p.display_name);
      }
      const normalize=v=>String(v||"").trim().replace(/\\s+/g," ").toLocaleLowerCase();
      const monthLabel=month=>new Date(month+"-01T12:00:00").toLocaleDateString(undefined,{month:"long",year:"numeric"});
      const pairKey=m=>{
        const a=normalize(names[m.player_id]||"Unknown player");
        const b=normalize(m.opponent_name||"Unknown opponent");
        return [a,b].sort().join("::");
      };
      // Sequence is based on every submission in the match month, including pending/rejected.
      const sequences={};
      matches.slice().sort((a,b)=>
        String(a.match_date||"").localeCompare(String(b.match_date||"")) ||
        String(a.submitted_at||"").localeCompare(String(b.submitted_at||"")) ||
        String(a.id||"").localeCompare(String(b.id||""))
      ).forEach(m=>{
        const month=String(m.match_date||m.submitted_at||"").slice(0,7)||"unknown";
        const key=month+"|"+pairKey(m);
        sequences[m.id]=(sequences[key]||0)+1;
        sequences[key]=sequences[m.id];
      });
      const groups={};
      matches.forEach(m=>{
        const month=String(m.match_date||m.submitted_at||"").slice(0,7)||"unknown";
        (groups[month]||(groups[month]=[])).push(m);
      });
      const months=Object.keys(groups).sort((a,b)=>b.localeCompare(a));
      const renderMonth=month=>{
        const rows=groups[month].map(m=>{
          const submittedBy=names[m.player_id]||"Unknown player";
          const opponent=m.opponent_name||"Unknown opponent";
          const seq=sequences[m.id]||1;
          const official=m.status==="approved"&&m.counted===true;
          return '<tr><td>'+prettyDate(m.match_date)+'</td>'+
            '<td>'+esc(submittedBy)+'</td>'+
            '<td>'+esc(submittedBy)+' <span class="muted">vs</span> '+esc(opponent)+'</td>'+
            '<td><b>'+m.player_goals+' – '+m.opponent_goals+'</b></td>'+
            '<td><span class="pill">'+seq+'/5</span></td>'+
            '<td>'+esc(m.result||"—")+'</td>'+
            '<td><span class="pill '+(m.status==="approved"?"good":m.status==="rejected"?"bad":"pending")+'">'+esc(m.status||"unknown")+'</span></td>'+
            '<td><span class="pill '+(official?"good":"")+'">'+(official?"Yes":"No")+'</span></td>'+
            '<td>'+esc(m.exclusion_reason||"—")+'</td>'+
            '<td>'+esc(m.submitted_at?new Date(m.submitted_at).toLocaleString():"—")+'</td></tr>';
        }).join("");
        return '<details class="panel month-history-group" open><summary><b>'+esc(monthLabel(month))+'</b><span class="muted">'+groups[month].length+' submissions</span></summary>'+
          '<div class="table-wrap"><table><thead><tr><th>Match date</th><th>Submitted by</th><th>Complete lineup</th><th>Score</th><th>Lineup sequence</th><th>Result</th><th>Status</th><th>Officially counted</th><th>Exclusion reason</th><th>Submitted at</th></tr></thead><tbody>'+rows+'</tbody></table></div></details>';
      };
      $("allMatchHistoryGroups").innerHTML=months.length
        ?months.map(renderMonth).join("")
        :'<div class="panel soft">No match records found.</div>';
      status("allMatchHistoryStatus",matches.length+" total submissions across "+months.length+" match month(s). Each lineup is counted in both directions together. Lineup sequence includes pending and rejected submissions; “Officially counted” means approved and counted. Monthly groups are based on match date.");
    }catch(err){
      status("allMatchHistoryStatus",err.message||"Could not load all match history.","error");
    }
  }

  async function recoverPlayerAccount(playerId,button){
    if(!state.isAdmin||!state.session)return;
    const playerName=button.closest("tr")?.querySelector("td")?.textContent?.trim()||"this player";
    if(!confirm("Send a password reset email to the registered email address for "+playerName+"? The email address will not be displayed."))return;
    button.disabled=true;
    const originalText=button.textContent;
    button.textContent="Sending…";
    status("adminStatus","Requesting password reset email for "+playerName+"…");
    try{
      const {data,error}=await client.functions.invoke("admin-account-recovery",{body:{player_id:playerId}});
      if(error)throw error;
      if(data?.error)throw new Error(data.error);
      status("adminStatus",data?.message||"Password reset email requested.","success");
    }catch(err){
      console.error("Account recovery request failed:",err);
      status("adminStatus",err.message||"Could not request a password reset email.","error");
    }finally{button.disabled=false;button.textContent=originalText;}
  }

  async function reviewMatch(id,approve){
    if(!client||!state.isAdmin)return;
    let reason="";
    if(!approve){reason=prompt("Reason for rejection (optional):")??"";if(reason===null)return;}
    const {data,error}=approve?await client.rpc("approve_match",{p_match_id:id}):await client.rpc("reject_match",{p_match_id:id,p_reason:reason});
    if(error){status("adminStatus",error.message,"error");return;}
    status("adminStatus",data|| (approve?"Approved.":"Rejected."),"success");await loadAdmin();loadLeaderboard();
  }
  $("memberForm").addEventListener("submit",async e=>{
    e.preventDefault();if(!state.isAdmin)return;
    const name=$("newMemberName").value.trim();if(!name)return;
    const {error}=await client.from("cobeg_members").insert({name,active:true});
    if(error){status("adminStatus",error.message,"error");return;}
    $("newMemberName").value="";toast("COBEG XI member added.");await loadAdmin();await loadMembers();
  });

  async function boot(){
    if(!client){setAuthUI();return;}
    client.auth.onAuthStateChange(async(event,session)=>{
      state.session=session;
      if(event==="PASSWORD_RECOVERY"){
        state.recoveryMode=true;
        setAuthUI();
        showView("account");
        return;
      }
      if(session){try{await loadIdentity();}catch(e){console.error(e);}}
      else{state.profile=null;state.player=null;state.isAdmin=false;}
      setAuthUI();
    });
    const urlParams=new URLSearchParams(location.search);
    const hashParams=new URLSearchParams(location.hash.startsWith("#")?location.hash.slice(1):location.hash);
    const code=urlParams.get("code");
    const recoveryHash=hashParams.get("type")==="recovery" || urlParams.get("type")==="recovery" || !!code;
    if(code){
      const {data:codeData,error:codeError}=await client.auth.exchangeCodeForSession(code);
      if(codeError)console.error("Could not exchange recovery link code:",codeError.message);
      else if(codeData?.session)state.session=codeData.session;
    }
    const {data:sessionData,error:sessionError}=await client.auth.getSession();
    state.session=state.session||sessionData?.session||null;
    const accessToken=hashParams.get("access_token");
    const refreshToken=hashParams.get("refresh_token");
    if(recoveryHash && !state.session && accessToken && refreshToken){
      const {data:recoverySession,error:recoveryError}=await client.auth.setSession({
        access_token:accessToken,
        refresh_token:refreshToken
      });
      if(!recoveryError && recoverySession?.session)state.session=recoverySession.session;
      else console.error("Could not establish recovery session:",recoveryError?.message||sessionError?.message);
    }
    if(recoveryHash && state.session){
      state.recoveryMode=true;
      setAuthUI();
      showView("account");
    }else{
      if(state.session)await loadIdentity();
      setAuthUI();
      if(recoveryHash && !state.session){
        status("authMessage","This recovery link could not establish a valid session. Request a fresh password reset email and open the newest link in the same browser.","error");
        showView("account");
      }
    }
    await loadMembers();await loadLeaderboard();await loadPublicPoster();
  }
  boot();
})();
