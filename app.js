(() => {
  const cfg = window.BPC_CONFIG || {};
  const configReady = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
    !cfg.SUPABASE_URL.includes("PASTE_") && !cfg.SUPABASE_ANON_KEY.includes("PASTE_");
  const client = configReady ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
  const $ = id => document.getElementById(id);
  const state = { session:null, profile:null, player:null, isAdmin:false, signup:false, members:[] };
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
    if(name==="home")loadLeaderboard();
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

  if(!configReady){
    status("leaderboardStatus","Setup required: open config.js and paste your Supabase Project URL and anon/public key.","error");
    $("leaderboardBody").innerHTML='<tr><td colspan="12" class="empty">Complete the setup steps in README.md to connect the database.</td></tr>';
    $("authSubmit").disabled=true;$("matchSubmit").disabled=true;
  }

  function setAuthUI(){
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
  async function loadMembers(){
    if(!client)return;
    const {data,error}=await client.from("cobeg_members").select("id,name,active").eq("active",true).order("name");
    if(error){console.error(error);return;}
    state.members=data||[];
    const sel=$("cobegOpponent");sel.innerHTML='<option value="">Choose COBEG XI member</option>';
    state.members.forEach(m=>{const o=document.createElement("option");o.value=m.id;o.textContent=m.name;sel.appendChild(o);});
  }
  $("opponentType").addEventListener("change",()=>{
    const isCobeg=$("opponentType").value==="cobeg";
    $("cobegOpponentLabel").classList.toggle("hidden",!isCobeg);
    $("otherOpponentLabel").classList.toggle("hidden",isCobeg);
    $("cobegOpponent").required=isCobeg;$("otherOpponent").required=!isCobeg;
  });
  $("matchForm").addEventListener("submit",async e=>{
    e.preventDefault();if(!client||!state.session){toast("Please sign in first.");showView("account");return;}
    if(!state.player||!state.player.active){status("matchMessage","Your player profile is not active. Contact an admin.","error");return;}
    const type=$("opponentType").value, member=state.members.find(m=>m.id===$("cobegOpponent").value);
    const opponent=type==="cobeg"?(member?.name||""):$("otherOpponent").value.trim();
    const date=$("matchDate").value, pg=Number($("playerGoals").value), og=Number($("opponentGoals").value);
    if(!opponent||!date||!Number.isInteger(pg)||!Number.isInteger(og)||pg<0||og<0){status("matchMessage","Please complete the required fields with valid scores.","error");return;}
    if(opponent.toLowerCase().trim()===state.player.display_name.toLowerCase().trim()){status("matchMessage","You cannot submit yourself as your opponent.","error");return;}
    const btn=$("matchSubmit");btn.disabled=true;btn.textContent="Submitting…";
    try{
      const {data,error}=await client.rpc("submit_match",{p_opponent_name:opponent,p_match_date:date,p_player_goals:pg,p_opponent_goals:og,p_notes:$("matchNotes").value,p_cobeg_member_id:type==="cobeg"?member.id:null});
      if(error)throw error;
      $("matchForm").reset();$("matchDate").value=new Date().toISOString().slice(0,10);
      $("opponentType").dispatchEvent(new Event("change"));
      status("matchMessage","Result submitted successfully. It is now pending admin approval. Reference: "+data,"success");
      toast("Result submitted for review.");
    }catch(err){status("matchMessage",err.message||String(err),"error");}
    finally{btn.disabled=false;btn.textContent="Submit result";}
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
    if(!state.session){$("historySignIn").classList.remove("hidden");$("historyContent").classList.add("hidden");return;}
    $("historySignIn").classList.add("hidden");$("historyContent").classList.remove("hidden");
    status("historyStatus","Loading your history…");
    let q=client.from("matches").select("id,opponent_name,match_date,player_goals,opponent_goals,result,points,status,counted,exclusion_reason,submitted_at").order("match_date",{ascending:false}).order("submitted_at",{ascending:false}).limit(500);
    const month=$("historyMonth").value;
    if(month){const d1=month+"-01";const d=new Date(d1+"T12:00:00");d.setMonth(d.getMonth()+1);const d2=d.toISOString().slice(0,10);q=q.gte("match_date",d1).lt("match_date",d2);}
    const {data,error}=await q;
    if(error){status("historyStatus",error.message,"error");return;}
    status("historyStatus",(data||[]).length+" results in this view.");
    $("historyBody").innerHTML=(data||[]).length?(data||[]).map(m=>'<tr><td>'+prettyDate(m.match_date)+'</td><td>'+esc(m.opponent_name)+'</td><td><b>'+m.player_goals+' – '+m.opponent_goals+'</b></td><td>'+m.result+'</td><td>'+m.points+'</td><td><span class="pill '+(m.status==="approved"?"good":m.status==="rejected"?"bad":"pending")+'">'+esc(m.status)+'</span></td><td><span class="pill '+(m.counted?"good":"")+'">'+(m.counted?"Yes":"No")+'</span></td></tr>').join(""):'<tr><td colspan="7" class="empty">No match results found for this month.</td></tr>';
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
    const ps=await client.from("players").select("id,display_name,active,created_at").order("created_at",{ascending:false}).limit(100);
    $("playersBody").innerHTML=(ps.data||[]).map(p=>'<tr><td>'+esc(p.display_name)+'</td><td><span class="pill '+(p.active?'good':'bad')+'">'+(p.active?'Active':'Inactive')+'</span></td><td>'+prettyDate(p.created_at?.slice(0,10))+'</td></tr>').join("");
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
    client.auth.onAuthStateChange(async(_event,session)=>{
      state.session=session;
      if(session){try{await loadIdentity();}catch(e){console.error(e);}}
      else{state.profile=null;state.player=null;state.isAdmin=false;}
      setAuthUI();
    });
    const {data}=await client.auth.getSession();state.session=data.session;
    if(state.session)await loadIdentity();
    setAuthUI();await loadMembers();await loadLeaderboard();
  }
  boot();
})();