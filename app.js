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
  registeredPlayers:[],
  canAccessFunds:false
};
  const BRAND_DEFAULTS={name:"Brahmanbaria Pes Club",subtitle:"Official Website",logo_path:null};
  let siteBranding={...BRAND_DEFAULTS};
  function renderBranding(){
    $("siteBrandName").textContent=siteBranding.name||BRAND_DEFAULTS.name;
    $("siteBrandSubtitle").textContent=siteBranding.subtitle||BRAND_DEFAULTS.subtitle;
    const logo=$("siteLogo"),fallback=$("siteLogoFallback");
    if(siteBranding.logo_path&&client){
      logo.src=client.storage.from("bpc-posters").getPublicUrl(siteBranding.logo_path).data.publicUrl;
      logo.classList.remove("hidden");fallback.classList.add("hidden");
    }else{logo.removeAttribute("src");logo.classList.add("hidden");fallback.classList.remove("hidden");}
  }
  async function loadBranding(){
    renderBranding();
    if(!client)return;
    const {data,error}=await client.from("site_branding").select("club_name,subtitle,logo_path").eq("id",1).maybeSingle();
    if(!error&&data)siteBranding={name:data.club_name||BRAND_DEFAULTS.name,subtitle:data.subtitle||BRAND_DEFAULTS.subtitle,logo_path:data.logo_path||null};
    renderBranding();
    $("brandNameInput").value=siteBranding.name;
    $("brandSubtitleInput").value=siteBranding.subtitle;
  }
  loadBranding();
  $("brandingForm").addEventListener("submit",async e=>{
    e.preventDefault();
    if(!state.isAdmin||!state.session){status("brandingStatus","Only an admin can save website branding.","error");return;}
    const name=$("brandNameInput").value.trim(),subtitle=$("brandSubtitleInput").value.trim(),file=$("brandLogoFile").files?.[0];
    if(!name||!subtitle){status("brandingStatus","Enter both the club name and subtitle.","error");return;}
    if(file&&file.size>8*1024*1024){status("brandingStatus","Logo must be 8 MB or smaller.","error");return;}
    if(file&&![ "image/jpeg","image/png","image/webp","image/gif"].includes(file.type)){status("brandingStatus","Choose a JPG, PNG, WEBP, or GIF logo.","error");return;}
    const btn=$("saveBrandingBtn");btn.disabled=true;status("brandingStatus","Saving website branding…");
    try{
      let logoPath=siteBranding.logo_path;
      if(file){
        logoPath="branding/"+Date.now()+"-"+file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
        const up=await client.storage.from("bpc-posters").upload(logoPath,file,{contentType:file.type,upsert:false});
        if(up.error)throw up.error;
      }
      const {error}=await client.from("site_branding").upsert({id:1,club_name:name,subtitle,logo_path:logoPath,updated_by:state.session.user.id,updated_at:new Date().toISOString()},{onConflict:"id"});
      if(error)throw error;
      siteBranding={name,subtitle,logo_path:logoPath};renderBranding();$("brandLogoFile").value="";
      status("brandingStatus","Branding saved. The website header is updated.","success");
    }catch(err){status("brandingStatus",err.message||"Could not save branding. Run the branding SQL migration first.","error");}
    finally{btn.disabled=false;}
  });
  let posterSlides = [];
  let posterIndex = 0;
  let posterTimer = null;
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
    if(name==="funds"&&!state.canAccessFunds){toast("BPC Funds is restricted to authorized accounts.");name="home";}
    document.querySelectorAll(".view").forEach(v=>v.classList.add("hidden"));
    const target=$("view-"+name);if(target)target.classList.remove("hidden");
    document.querySelectorAll(".navlink").forEach(b=>b.classList.toggle("active",b.dataset.view===name));
    $("nav").classList.remove("open");
    if(name==="home"){loadPublicPoster();loadHomeBanner();}
    else { $("uclPosterSection").classList.add("hidden"); $("homeBannerSection").classList.add("hidden"); if(posterTimer){clearInterval(posterTimer);posterTimer=null;} }
    if(name==="leaderboard")loadLeaderboard();
    if(name==="history")loadHistory();
    if(name==="official")loadOfficialPage();
    if(name==="funds")loadFundsPage();
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

  function renderPosterSlide(){
    const section=$("uclPosterSection");
    if(!posterSlides.length){section.classList.add("hidden");return;}
    if(posterIndex>=posterSlides.length)posterIndex=0;
    if(posterIndex<0)posterIndex=posterSlides.length-1;
    const p=posterSlides[posterIndex];
    $("posterTitle").textContent=p.title||"Club Announcement";
    $("posterImage").src=client.storage.from("bpc-posters").getPublicUrl(p.image_path).data.publicUrl;
    $("posterImage").alt=p.title||"Club announcement";
    $("posterCaption").textContent="Announcement "+(posterIndex+1)+" of "+posterSlides.length+" · Active until removed by an admin";
    const controls=$("posterControls");
    controls.classList.toggle("hidden",posterSlides.length<2);
    const indicators=$("posterIndicators");
    indicators.innerHTML=posterSlides.map((slide,i)=>'<button type="button" class="poster-indicator'+(i===posterIndex?' active':'')+'" aria-label="Show announcement '+(i+1)+'" aria-current="'+(i===posterIndex?'true':'false')+'" data-poster-index="'+i+'"></button>').join("");
    indicators.querySelectorAll("[data-poster-index]").forEach(button=>button.addEventListener("click",()=>{posterIndex=Number(button.dataset.posterIndex);renderPosterSlide();restartPosterTimer();}));
    section.classList.remove("hidden");
  }
  function restartPosterTimer(){
    if(posterTimer){clearInterval(posterTimer);posterTimer=null;}
    if(posterSlides.length>1)posterTimer=setInterval(()=>{posterIndex=(posterIndex+1)%posterSlides.length;renderPosterSlide();},6000);
  }
  async function loadPublicPoster(){
    if(!client)return;
    const section=$("uclPosterSection");
    const {data,error}=await client.from("site_posters").select("id,title,image_path,published_at,expires_at").eq("is_active",true).neq("title","BPC Home Banner").lte("published_at",new Date().toISOString()).gt("expires_at",new Date().toISOString()).order("published_at",{ascending:false}).limit(30);
    if(error||!data||!data.length){
      posterSlides=[];if(posterTimer){clearInterval(posterTimer);posterTimer=null;}
      section.classList.add("hidden");return;
    }
    posterSlides=data;
    posterIndex=0;
    renderPosterSlide();
    restartPosterTimer();
  }
  $("posterPrev").addEventListener("click",()=>{posterIndex=(posterIndex-1+posterSlides.length)%posterSlides.length;renderPosterSlide();restartPosterTimer();});
  $("posterNext").addEventListener("click",()=>{posterIndex=(posterIndex+1)%posterSlides.length;renderPosterSlide();restartPosterTimer();});

  function bannerDestinationValue(){
    const choice=$("bannerDestination").value;
    if(choice==="none")return "";
    if(choice==="custom"){
      const raw=$("bannerCustomUrl").value.trim();
      if(!raw)return null;
      try{const url=new URL(raw);if(url.protocol!=="https:"&&url.protocol!=="http:")return null;return url.href;}catch{return null;}
    }
    return ({home:"home",leaderboard:"leaderboard",history:"history",submit:"submit"})[choice]||"";
  }
  function renderHomeBannerLink(url){
    const img=$("homeBannerImage");
    $("homeBannerSection").dataset.destination=url||"";
    img.style.cursor=url?"pointer":"default";
    img.tabIndex=url?0:-1;
    img.setAttribute("role",url?"link":"img");
    img.setAttribute("aria-label",url?"Club banner — open destination":"BPC club performance banner");
  }
  function openBannerDestination(){
    const destination=$("homeBannerSection").dataset.destination;
    if(!destination)return;
    if(["home","leaderboard","history","submit"].includes(destination)){showView(destination);return;}
    try{const url=new URL(destination);if(url.protocol==="https:"||url.protocol==="http:")window.open(url.href,"_blank","noopener,noreferrer");}catch{}
  }
  $("bannerDestination").addEventListener("change",()=>{$("bannerCustomUrlLabel").classList.toggle("hidden",$("bannerDestination").value!=="custom");});
  $("homeBannerImage").addEventListener("click",openBannerDestination);
  $("homeBannerImage").addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();openBannerDestination();}});

  async function loadHomeBanner(){
    if(!client)return;
    const section=$("homeBannerSection");
    const {data,error}=await client.from("site_posters").select("id,image_path,link_url").eq("title","BPC Home Banner").eq("is_active",true).lte("published_at",new Date().toISOString()).gt("expires_at",new Date().toISOString()).order("created_at",{ascending:false}).limit(1);
    if(error||!data||!data.length){section.classList.add("hidden");return;}
    $("homeBannerImage").src=client.storage.from("bpc-posters").getPublicUrl(data[0].image_path).data.publicUrl;
    renderHomeBannerLink(data[0].link_url||"");
    section.classList.remove("hidden");
  }

  $("bannerForm").addEventListener("submit",async e=>{
    e.preventDefault();
    if(!state.isAdmin||!state.session)return;
    const file=$("bannerFile").files?.[0];
    if(!file){status("bannerAdminStatus","Choose a banner image first.","error");return;}
    if(file.size>8*1024*1024){status("bannerAdminStatus","Image must be 8 MB or smaller.","error");return;}
    if(!["image/jpeg","image/png","image/webp","image/gif"].includes(file.type)){status("bannerAdminStatus","Please choose a JPG, PNG, WEBP, or GIF image.","error");return;}
    const btn=$("publishBannerBtn");btn.disabled=true;status("bannerAdminStatus","Uploading banner…");
    const path="banners/"+Date.now()+"-"+file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
    try{
      const up=await client.storage.from("bpc-posters").upload(path,file,{contentType:file.type,upsert:false});
      if(up.error)throw up.error;
      const {error}=await client.from("site_posters").update({is_active:false}).eq("title","BPC Home Banner").eq("is_active",true);
      if(error)throw error;
      const destination=bannerDestinationValue();
      if(destination===null)throw new Error("Please enter a valid http:// or https:// custom URL.");
      const {error:insertError}=await client.from("site_posters").insert({title:"BPC Home Banner",image_path:path,link_url:destination||null,is_active:true,created_by:state.session.user.id,expires_at:"9999-12-31T23:59:59.000Z"});
      if(insertError)throw insertError;
      $("bannerFile").value="";
      status("bannerAdminStatus","Home banner uploaded. It will remain until you replace or remove it.","success");
      await loadHomeBanner();await loadPosterAdmin();
    }catch(err){status("bannerAdminStatus",err.message||"Could not upload banner.","error");}
    finally{btn.disabled=false;}
  });

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
      const {error:insertError}=await client.from("site_posters").insert({title,image_path:path,is_active:true,created_by:state.session.user.id,expires_at:"9999-12-31T23:59:59.000Z"});
      if(insertError)throw insertError;
      $("posterFile").value="";status("posterAdminStatus","Poster uploaded and published. It will remain visible until you remove it.","success");
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
    $("fundsNav").classList.toggle("hidden",!state.canAccessFunds);
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
    const {data:cobegTotals,error:cobegError}=await client.rpc("get_cobeg_match_totals",{p_month:monthDate(month)});
    if(cobegError){status("leaderboardStatus","Leaderboard loaded, but COBEG XI match totals could not be loaded: "+cobegError.message,"error");return;}
    const cobegByPlayer={};
    (cobegTotals||[]).forEach(row=>{cobegByPlayer[row.player_id]=Number(row.total_mp_vs_cobeg_xi)||0;});
    status("leaderboardStatus",data.length+" active players · Approved and counted results only.");
    const body=$("leaderboardBody");
    if(!data.length){body.innerHTML='<tr><td colspan="13" class="empty">No active players yet. Members can register to appear here.</td></tr>';return;}
    body.innerHTML=data.map(r=>{
      const total=cobegByPlayer[r.player_id]||0;
      const eligible=!!r.award_eligible;
      return '<tr><td class="'+(r.rank<=3?'rank-'+r.rank:'')+'">'+r.rank+'</td><td><div class="player-cell"><span class="avatar">'+esc((r.player_name||"?").split(/\\s+/).map(x=>x[0]).slice(0,2).join("").toUpperCase())+'</span>'+esc(r.player_name)+'</div></td><td>'+r.matches_played+'</td><td>'+r.wins+'</td><td>'+r.draws+'</td><td>'+r.losses+'</td><td>'+r.goals_for+'</td><td>'+r.goals_against+'</td><td>'+signed(r.goal_difference)+'</td><td class="points">'+r.points+'</td><td>'+r.cobeg_opponents+'/5</td><td>'+total+'/25</td><td><span class="pill '+(eligible?'good':'')+'">'+(eligible?'Eligible':'In progress')+'</span></td></tr>';
    }).join("");
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
    // Use the readable directory exposed to signed-in players.
    // Direct reads from "players" may be restricted by row-level security,
    // causing valid submitted-by names to appear as "Unknown player".
    const {data:players,error:playersError} = await client
      .from("active_player_directory")
      .select("id,display_name")
      .in("id",playerIds);

    if(playersError){
      status("historyStatus",playersError.message,"error");
      return;
    }

    (players || []).forEach(p=>{
      if(p.id && p.display_name) playerNames[p.id] = p.display_name;
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

  const normalizeHistoryName = v => String(v || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const historyPairKey = m => [
    normalizeHistoryName(playerNames[m.player_id] || "Unknown player"),
    normalizeHistoryName(m.opponent_name || "Unknown opponent")
  ].sort().join("::");
  // Approved results alone advance the sequence, matching the admin history logic.
  const historySequences = {};
  matches.filter(m => m.status === "approved").slice().sort((a,b) =>
    String(a.match_date || "").localeCompare(String(b.match_date || "")) ||
    String(a.submitted_at || "").localeCompare(String(b.submitted_at || "")) ||
    String(a.id || "").localeCompare(String(b.id || ""))
  ).forEach(m => {
    const monthKey = String(m.match_date || m.submitted_at || "").slice(0,7) || "unknown";
    const key = monthKey + "|" + historyPairKey(m);
    historySequences[m.id] = (historySequences[key] || 0) + 1;
    historySequences[key] = historySequences[m.id];
  });

  const rows = personalMatches.map(m=>{
    const submittedName = (playerNames[m.player_id] || "").trim();
    const isOpponentView =
      submittedName.toLowerCase() !== myName &&
      (m.opponent_name || "").trim().toLowerCase() === myName;
    const common = {
      ...m,
      historySubmittedBy: submittedName || "—",
      historyLineup: (submittedName || "Unknown player") + " vs " + (m.opponent_name || "Unknown opponent"),
      historySequence: historySequences[m.id] || null
    };

    if(!isOpponentView){
      return {
        ...common,
        historyPlayerGoals: m.player_goals,
        historyOpponentGoals: m.opponent_goals,
        historyResult: m.result,
        historyPoints: m.points
      };
    }

    const myGoals = m.opponent_goals;
    const theirGoals = m.player_goals;
    const historyResult = myGoals > theirGoals ? "WIN" : myGoals < theirGoals ? "LOSS" : "DRAW";
    const historyPoints = myGoals > theirGoals ? 3 : myGoals === theirGoals ? 1 : 0;
    return {
      ...common,
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
      '<td>'+esc(m.historySubmittedBy)+'</td>'+
      '<td>'+esc(m.historyLineup)+'</td>'+
      '<td><b>'+m.historyPlayerGoals+' – '+m.historyOpponentGoals+'</b></td>'+
      '<td>'+esc(m.historyResult)+'</td>'+
      '<td>'+(m.historyPoints ?? m.points)+'</td>'+
      '<td>'+(m.historySequence?'<span class="pill">'+m.historySequence+'/5</span>':'<span class="muted">—</span>')+'</td>'+
      '<td><span class="pill '+(m.status==="approved"?"good":m.status==="rejected"?"bad":"pending")+'">'+esc(m.status)+'</span></td>'+
      '<td><span class="pill '+(m.counted?"good":"")+'">'+(m.counted?"Yes":"No")+'</span></td></tr>'
    ).join("")
    : '<tr><td colspan="9" class="empty">No match results found for this month.</td></tr>';
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
    await loadFundsAccessAdmin();
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

  let headToHeadFilter={a:"",b:""};
  $("searchHeadToHead").addEventListener("click",()=>{const a=$("headToHeadPlayerA").value,b=$("headToHeadPlayerB").value;if(!a||!b){status("allMatchHistoryStatus","Choose both players to search.","error");return;}if(a===b){status("allMatchHistoryStatus","Choose two different players.","error");return;}headToHeadFilter={a,b};loadAllMatchHistory();});
  $("clearHeadToHead").addEventListener("click",()=>{headToHeadFilter={a:"",b:""};$("headToHeadPlayerA").value="";$("headToHeadPlayerB").value="";loadAllMatchHistory();});

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
      // Populate the head-to-head selectors from registered player profiles,
      // not only from players who already have a match in the current history result.
      const {data:players,error:playersError}=await client.from("players")
        .select("id,display_name")
        .order("display_name",{ascending:true});
      if(playersError)throw playersError;
      const names={};
      (players||[]).forEach(p=>{if(p.id&&p.display_name)names[p.id]=p.display_name;});
      // Keep names for match records even if a legacy player profile is no longer present.
      const missingIds=[...new Set(matches.map(m=>m.player_id).filter(id=>id&&!names[id]))];
      for(let i=0;i<missingIds.length;i+=200){
        const batch=missingIds.slice(i,i+200);
        const {data:legacyPlayers,error:legacyError}=await client.from("players")
          .select("id,display_name").in("id",batch);
        if(legacyError)throw legacyError;
        (legacyPlayers||[]).forEach(p=>{if(p.id&&p.display_name)names[p.id]=p.display_name;});
      }
      const normalize=v=>String(v||"").trim().replace(/\s+/g," ").toLocaleLowerCase();
      const playerOptions=Object.entries(names).map(([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name));
      for(const id of ["headToHeadPlayerA","headToHeadPlayerB"]){
        const el=$(id),selected=el.value;
        el.innerHTML='<option value="">Choose player</option>'+playerOptions.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join("");
        if(selected&&playerOptions.some(p=>p.id===selected))el.value=selected;
      }
      const monthLabel=month=>new Date(month+"-01T12:00:00").toLocaleDateString(undefined,{month:"long",year:"numeric"});
      const pairKey=m=>{
        const a=normalize(names[m.player_id]||"Unknown player");
        const b=normalize(m.opponent_name||"Unknown opponent");
        return [a,b].sort().join("::");
      };
      // Only approved results receive a lineup sequence; pending/rejected rows remain visible but do not advance it.
      const sequences={};
      matches.filter(m=>m.status==="approved").slice().sort((a,b)=>
        String(a.match_date||"").localeCompare(String(b.match_date||"")) ||
        String(a.submitted_at||"").localeCompare(String(b.submitted_at||"")) ||
        String(a.id||"").localeCompare(String(b.id||""))
      ).forEach(m=>{
        const month=String(m.match_date||m.submitted_at||"").slice(0,7)||"unknown";
        const key=month+"|"+pairKey(m);
        sequences[m.id]=(sequences[key]||0)+1;
        sequences[key]=sequences[m.id];
      });
      const allMatches=matches;
      const filteredMatches=headToHeadFilter.a&&headToHeadFilter.b?allMatches.filter(m=>{const submitted=normalize(names[m.player_id]||"");const opponent=normalize(m.opponent_name||"");const a=normalize(names[headToHeadFilter.a]||"");const b=normalize(names[headToHeadFilter.b]||"");return (submitted===a&&opponent===b)||(submitted===b&&opponent===a);}):allMatches;
      const groups={};
      filteredMatches.forEach(m=>{
        const month=String(m.match_date||m.submitted_at||"").slice(0,7)||"unknown";
        (groups[month]||(groups[month]=[])).push(m);
      });
      const months=Object.keys(groups).sort((a,b)=>b.localeCompare(a));
      const renderMonth=month=>{
        const rows=groups[month].map(m=>{
          const submittedBy=names[m.player_id]||"Unknown player";
          const opponent=m.opponent_name||"Unknown opponent";
          const seq=sequences[m.id]||null;
          const official=m.status==="approved"&&m.counted===true;
          return '<tr><td>'+prettyDate(m.match_date)+'</td>'+
            '<td>'+esc(submittedBy)+'</td>'+
            '<td>'+esc(submittedBy)+' <span class="muted">vs</span> '+esc(opponent)+'</td>'+
            '<td><b>'+m.player_goals+' – '+m.opponent_goals+'</b></td>'+
            '<td>'+(seq?'<span class="pill">'+seq+'/5</span>':'<span class="muted">Not counted (not approved)</span>')+'</td>'+
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
      status("allMatchHistoryStatus",headToHeadFilter.a&&headToHeadFilter.b?filteredMatches.length+" matching submissions between "+(names[headToHeadFilter.a]||"Player A")+" and "+(names[headToHeadFilter.b]||"Player B")+". Includes both directions and all statuses.":"Showing all "+matches.length+" submissions across "+months.length+" match month(s). Each lineup is counted in both directions together. Only approved results advance the lineup sequence; pending and rejected submissions remain visible but do not count. “Officially counted” means approved and counted. Monthly groups are based on match date.");
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


  // Official Matches is isolated from the friendly-match tables and leaderboard.
  const officialState={players:[],seasons:[],matches:[],editors:[],mode:"all",loaded:false,canEdit:false};
  const officialResult=(gf,ga)=>gf>ga?"Win":gf<ga?"Loss":"Draw";
  function officialStats(playerId,season){
    const rows=officialState.matches.filter(m=>m.player_id===playerId&&(!season||(m.match_date>=season.start_date&&m.match_date<=season.end_date)));
    const s={played:rows.length,w:0,d:0,l:0,gf:0,ga:0,pts:0};
    rows.forEach(m=>{s.gf+=Number(m.goals_for);s.ga+=Number(m.goals_against);if(m.goals_for>m.goals_against){s.w++;s.pts+=3;}else if(m.goals_for===m.goals_against){s.d++;s.pts++;}else s.l++;});
    s.gd=s.gf-s.ga;return s;
  }
  function renderOfficialStandings(){
    const season=officialState.mode==="season"?officialState.seasons.find(s=>s.id===$("officialSeasonPicker").value):null;
    $("officialSeasonPickerWrap").classList.toggle("hidden",officialState.mode!=="season");
    $("officialAllTimeTab").className=officialState.mode==="all"?"primary":"secondary";
    $("officialSeasonTab").className=officialState.mode==="season"?"primary":"secondary";
    $("officialSeasonDates").textContent=season?prettyDate(season.start_date)+" – "+prettyDate(season.end_date):"";
    const rows=officialState.players.map(p=>({p,s:officialStats(p.id,season)})).sort((a,b)=>b.s.pts-a.s.pts||b.s.gd-a.s.gd||b.s.w-a.s.w||a.p.display_name.localeCompare(b.p.display_name));
    $("officialStandingsBody").innerHTML=rows.length?rows.map((r,i)=>'<tr><td>'+ (i+1)+'</td><td>'+esc(r.p.display_name)+'</td><td>'+r.s.played+'</td><td>'+r.s.w+'</td><td>'+r.s.d+'</td><td>'+r.s.l+'</td><td>'+r.s.gf+'</td><td>'+r.s.ga+'</td><td>'+ (r.s.gd>0?"+":"")+r.s.gd+'</td><td class="points">'+r.s.pts+'</td></tr>').join(""):'<tr><td colspan="10" class="empty">No registered players found.</td></tr>';
  }
  async function loadOfficialPage(){
    if(!client){status("officialStatus","Database connection is not configured.","error");return;}
    status("officialStatus","Loading official standings…");
    try{
      const [p,s,m,e]=await Promise.all([
        client.from("official_player_directory").select("id,display_name").order("display_name"),
        client.from("official_seasons").select("id,name,start_date,end_date,is_closed").order("start_date",{ascending:false}),
        client.from("official_matches").select("id,player_id,match_date,goals_for,goals_against,created_at").order("match_date",{ascending:false}),
        state.session?client.from("official_matches_editors").select("user_id,assigned_at"):Promise.resolve({data:[],error:null})
      ]);
      for(const x of [p,s,m,e])if(x.error)throw x.error;
      officialState.players=p.data||[];officialState.seasons=s.data||[];officialState.matches=m.data||[];officialState.editors=e.data||[];
      const uid=state.session?.user?.id;
      officialState.canEdit=!!uid&&(state.isAdmin||officialState.editors.some(x=>x.user_id===uid));
      $("officialEditorPanel").classList.toggle("hidden",!officialState.canEdit);
      const editorAdminControls=$("officialEditorAdminControls");if(editorAdminControls)editorAdminControls.classList.toggle("hidden",!state.isAdmin);
      const seasonPicker=$("officialSeasonPicker"),old=seasonPicker.value;
      seasonPicker.innerHTML=officialState.seasons.length?officialState.seasons.map(x=>'<option value="'+x.id+'">'+esc(x.name)+(x.is_closed?' (closed)':'')+'</option>').join(""):'<option value="">No seasons created</option>';
      if(officialState.seasons.some(x=>x.id===old))seasonPicker.value=old;
      $("officialPlayer").innerHTML=officialState.players.map(x=>'<option value="'+x.id+'">'+esc(x.display_name)+'</option>').join("");
      $("officialMatchDate").value=$("officialMatchDate").value||new Date().toISOString().slice(0,10);
      $("officialEditorAccount").innerHTML='<option value="">Choose registered account</option>';
      if(state.isAdmin){
        const {data:accounts,error}=await client.from("players").select("user_id,display_name").not("user_id","is",null).order("display_name");
        if(error)throw error;
        $("officialEditorAccount").innerHTML='<option value="">Choose registered account</option>'+(accounts||[]).map(x=>'<option value="'+x.user_id+'">'+esc(x.display_name)+'</option>').join("");
      }
      renderOfficialStandings();renderOfficialResults();renderOfficialSeasons();renderOfficialEditors();
      status("officialStatus",officialState.mode==="season"&&!officialState.seasons.length?"Create a season to view season-specific standings.":"Official standings updated.","success");
    }catch(err){status("officialStatus",err.message||"Could not load official matches. Run the official-matches SQL migration first.","error");}
  }
  function renderOfficialResults(){
    const sorted=[...officialState.matches].sort((a,b)=>b.match_date.localeCompare(a.match_date));
    $("officialResultsBody").innerHTML=sorted.length?sorted.map(m=>{const p=officialState.players.find(x=>x.id===m.player_id);return '<tr><td>'+prettyDate(m.match_date)+'</td><td>'+esc(p?.display_name||"Registered player")+'</td><td>'+m.goals_for+' – '+m.goals_against+'</td><td>'+officialResult(m.goals_for,m.goals_against)+'</td><td><button type="button" class="secondary" data-official-edit="'+m.id+'">Edit</button> <button type="button" class="reject-btn" data-official-delete="'+m.id+'">Delete</button></td></tr>';}).join(""):'<tr><td colspan="5" class="empty">No official results recorded yet.</td></tr>';
    document.querySelectorAll("[data-official-edit]").forEach(b=>b.onclick=()=>{const m=officialState.matches.find(x=>x.id===b.dataset.officialEdit);if(!m)return;$("officialResultId").value=m.id;$("officialPlayer").value=m.player_id;$("officialMatchDate").value=m.match_date;$("officialGoalsFor").value=m.goals_for;$("officialGoalsAgainst").value=m.goals_against;$("officialSaveResult").textContent="Update official result";$("officialCancelEdit").classList.remove("hidden");$("officialResultForm").scrollIntoView({behavior:"smooth",block:"center"});});
    document.querySelectorAll("[data-official-delete]").forEach(b=>b.onclick=async()=>{if(!confirm("Delete this official result? Standings will be recalculated."))return;const {error}=await client.from("official_matches").delete().eq("id",b.dataset.officialDelete);if(error){status("officialEditorStatus",error.message,"error");return;}toast("Official result deleted.");await loadOfficialPage();});
  }
  function renderOfficialSeasons(){
    $("officialSeasonAdminList").innerHTML=officialState.seasons.map(s=>'<span class="member-chip">'+esc(s.name)+' · '+prettyDate(s.start_date)+'–'+prettyDate(s.end_date)+(s.is_closed?' · Closed':'')+' <button type="button" class="secondary" data-season-edit="'+s.id+'">Edit</button> <button type="button" class="secondary" data-season-close="'+s.id+'">'+(s.is_closed?'Reopen':'Close')+'</button></span>').join("")||'<span class="small">No seasons yet.</span>';
    document.querySelectorAll("[data-season-edit]").forEach(b=>b.onclick=()=>{const s=officialState.seasons.find(x=>x.id===b.dataset.seasonEdit);if(!s)return;$("officialSeasonId").value=s.id;$("officialSeasonName").value=s.name;$("officialSeasonStart").value=s.start_date;$("officialSeasonEnd").value=s.end_date;$("officialSaveSeason").textContent="Update season";$("officialCancelSeasonEdit").classList.remove("hidden");});
    document.querySelectorAll("[data-season-close]").forEach(b=>b.onclick=async()=>{const s=officialState.seasons.find(x=>x.id===b.dataset.seasonClose);if(!s)return;const {error}=await client.from("official_seasons").update({is_closed:!s.is_closed}).eq("id",s.id);if(error){status("officialEditorStatus",error.message,"error");return;}await loadOfficialPage();});
  }
  function renderOfficialEditors(){
    $("officialEditorList").innerHTML=state.isAdmin?officialState.editors.map(e=>{const p=officialState.players.find(x=>x.user_id===e.user_id);return '<span class="member-chip">'+esc(p?.display_name||"Assigned account")+' <button type="button" class="reject-btn" data-editor-remove="'+e.user_id+'">Remove</button></span>';}).join("")||'<span class="small">No designated editor assigned.</span>':"";
    document.querySelectorAll("[data-editor-remove]").forEach(b=>b.onclick=async()=>{if(!confirm("Remove this page editor?"))return;const {error}=await client.from("official_matches_editors").delete().eq("user_id",b.dataset.editorRemove);if(error){status("officialEditorStatus",error.message,"error");return;}await loadOfficialPage();});
  }
  $("officialAllTimeTab").addEventListener("click",()=>{officialState.mode="all";renderOfficialStandings();});
  $("officialSeasonTab").addEventListener("click",()=>{officialState.mode="season";renderOfficialStandings();});
  $("officialSeasonPicker").addEventListener("change",renderOfficialStandings);
  $("officialResultForm").addEventListener("submit",async ev=>{
    ev.preventDefault();if(!officialState.canEdit)return;
    const id=$("officialResultId").value;
    const row={player_id:$("officialPlayer").value,match_date:$("officialMatchDate").value,goals_for:Number($("officialGoalsFor").value),goals_against:Number($("officialGoalsAgainst").value),updated_by:state.session.user.id};
    if(!row.player_id||!row.match_date||row.goals_for<0||row.goals_against<0||!Number.isInteger(row.goals_for)||!Number.isInteger(row.goals_against)){status("officialEditorStatus","Choose a player, date, and valid whole-number scores.","error");return;}
    const result=id?await client.from("official_matches").update(row).eq("id",id):await client.from("official_matches").insert({...row,created_by:state.session.user.id});
    if(result.error){status("officialEditorStatus",result.error.message,"error");return;}
    $("officialResultForm").reset();$("officialResultId").value="";$("officialSaveResult").textContent="Save official result";$("officialCancelEdit").classList.add("hidden");toast(id?"Official result updated.":"Official result saved.");await loadOfficialPage();
  });
  $("officialCancelEdit").addEventListener("click",()=>{$("officialResultForm").reset();$("officialResultId").value="";$("officialSaveResult").textContent="Save official result";$("officialCancelEdit").classList.add("hidden");});
  $("officialSeasonForm").addEventListener("submit",async ev=>{
    ev.preventDefault();if(!officialState.canEdit)return;
    const id=$("officialSeasonId").value,name=$("officialSeasonName").value.trim(),start_date=$("officialSeasonStart").value,end_date=$("officialSeasonEnd").value;
    if(!name||!start_date||!end_date||end_date<start_date){status("officialEditorStatus","Enter a season name and valid date range.","error");return;}
    const payload={name,start_date,end_date,updated_by:state.session.user.id};
    const result=id?await client.from("official_seasons").update(payload).eq("id",id):await client.from("official_seasons").insert({...payload,created_by:state.session.user.id});
    if(result.error){status("officialEditorStatus",result.error.message,"error");return;}
    $("officialSeasonForm").reset();$("officialSeasonId").value="";$("officialSaveSeason").textContent="Save season";$("officialCancelSeasonEdit").classList.add("hidden");toast("Season saved.");await loadOfficialPage();
  });
  $("officialCancelSeasonEdit").addEventListener("click",()=>{$("officialSeasonForm").reset();$("officialSeasonId").value="";$("officialSaveSeason").textContent="Save season";$("officialCancelSeasonEdit").classList.add("hidden");});

  async function refreshFundsAccess(){
    state.canAccessFunds=!!state.isAdmin;
    if(client&&state.session&&!state.isAdmin){
      const {data,error}=await client.from("bpc_funds_access").select("user_id").eq("user_id",state.session.user.id).maybeSingle();
      state.canAccessFunds=!error&&!!data;
    }
    const nav=$("fundsNav");if(nav)nav.classList.toggle("hidden",!state.canAccessFunds);
    const current=$("view-funds");
    if(current&&!current.classList.contains("hidden")&&!state.canAccessFunds)showView("home");
  }
  async function loadFundsAccessAdmin(){
    if(!state.isAdmin||!client)return;
    status("fundsAccessStatus","Loading authorized accounts…");
    const [accountsResult,accessResult]=await Promise.all([
      client.from("players").select("user_id,display_name").not("user_id","is",null).order("display_name"),
      client.from("bpc_funds_access").select("user_id,granted_at").order("granted_at",{ascending:true})
    ]);
    if(accountsResult.error||accessResult.error){status("fundsAccessStatus",accountsResult.error?.message||accessResult.error?.message||"Could not load access list.","error");return;}
    const accounts=accountsResult.data||[], access=accessResult.data||[], names={};
    accounts.forEach(a=>{names[a.user_id]=a.display_name||"Registered account";});
    $("fundsAccessAccount").innerHTML='<option value="">Choose registered account</option>'+accounts.filter(a=>!access.some(x=>x.user_id===a.user_id)).map(a=>'<option value="'+esc(a.user_id)+'">'+esc(a.display_name||"Registered account")+'</option>').join("");
    $("fundsAccessList").innerHTML=access.length?access.map(a=>'<div class="member-chip">'+esc(names[a.user_id]||a.user_id)+' <button type="button" class="reject-btn" data-revoke-funds="'+esc(a.user_id)+'">Remove access</button></div>').join(""):'<p class="small">No additional accounts have been granted access yet. Administrators always have access.</p>';
    status("fundsAccessStatus",access.length+" account(s) granted access.");
    document.querySelectorAll("[data-revoke-funds]").forEach(btn=>btn.onclick=async()=>{
      if(!state.isAdmin)return;
      const userId=btn.dataset.revokeFunds;
      if(!confirm("Remove BPC Funds access for "+(names[userId]||"this account")+"?"))return;
      const {error}=await client.from("bpc_funds_access").delete().eq("user_id",userId);
      if(error){status("fundsAccessStatus",error.message,"error");return;}
      await loadFundsAccessAdmin();toast("BPC Funds access removed.");
    });
  }
  $("fundsAccessForm").addEventListener("submit",async ev=>{
    ev.preventDefault();
    if(!state.isAdmin||!state.session){status("fundsAccessStatus","Only administrators can grant access.","error");return;}
    const user_id=$("fundsAccessAccount").value;
    if(!user_id){status("fundsAccessStatus","Choose an account first.","error");return;}
    const {error}=await client.from("bpc_funds_access").upsert({user_id,granted_by:state.session.user.id},{onConflict:"user_id"});
    if(error){status("fundsAccessStatus",error.message,"error");return;}
    await loadFundsAccessAdmin();toast("BPC Funds access granted.");
  });
  const fundMoney=value=>"৳"+Number(value||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  async function loadFundsPage(){
    if(!client||!state.session||!state.canAccessFunds){$("fundsDenied").classList.remove("hidden");$("fundsContent").classList.add("hidden");return;}
    $("fundsDenied").classList.add("hidden");$("fundsContent").classList.remove("hidden");
    $("fundDate").value=$("fundDate").value||new Date().toISOString().slice(0,10);
    if($("fundExpenseDate"))$("fundExpenseDate").value=$("fundExpenseDate").value||new Date().toISOString().slice(0,10);
    if($("fundExpenseForm"))$("fundExpenseForm").classList.toggle("hidden",!state.isAdmin);
    status("fundsStatus","Loading fund records…");
    const [donationsResult,expensesResult]=await Promise.all([
      client.from("bpc_fund_donations").select("id,donor_name,amount,donation_date,note,created_by,created_at").order("donation_date",{ascending:false}).order("created_at",{ascending:false}),
      client.from("bpc_fund_expenses").select("id,description,amount,expense_date,note,created_by,created_at").order("expense_date",{ascending:false}).order("created_at",{ascending:false})
    ]);
    if(donationsResult.error||expensesResult.error){
      const err=donationsResult.error||expensesResult.error;
      status("fundsStatus",err.message,"error");
      $("fundsHistoryBody").innerHTML='<tr><td colspan="5" class="empty">Could not load fund records. Run the BPC fund-expenses SQL migration.</td></tr>';
      if($("fundExpensesBody"))$("fundExpensesBody").innerHTML='<tr><td colspan="5" class="empty">Could not load expense history.</td></tr>';
      return;
    }
    const donations=donationsResult.data||[], expenses=expensesResult.data||[];
    const totalDonations=donations.reduce((sum,x)=>sum+Number(x.amount||0),0);
    const totalExpenses=expenses.reduce((sum,x)=>sum+Number(x.amount||0),0);
    $("fundTotalDonations").textContent=fundMoney(totalDonations);
    $("fundTotalExpenses").textContent=fundMoney(totalExpenses);
    $("fundCurrentBalance").textContent=fundMoney(totalDonations-totalExpenses);
    const ids=[...new Set([...donations,...expenses].map(x=>x.created_by))], names={};
    if(ids.length){const {data:profiles}=await client.from("profiles").select("id,display_name").in("id",ids);(profiles||[]).forEach(p=>names[p.id]=p.display_name||"Member");}
    $("fundsHistoryBody").innerHTML=donations.length?donations.map(d=>'<tr><td>'+prettyDate(d.donation_date)+'</td><td>'+esc(d.donor_name)+'</td><td>'+fundMoney(d.amount)+'</td><td>'+esc(d.note||"—")+'</td><td>'+esc(names[d.created_by]||"Member")+'</td></tr>').join(""):'<tr><td colspan="5" class="empty">No donations have been recorded yet.</td></tr>';
    if($("fundExpensesBody"))$("fundExpensesBody").innerHTML=expenses.length?expenses.map(d=>'<tr><td>'+prettyDate(d.expense_date)+'</td><td>'+esc(d.description)+'</td><td>'+fundMoney(d.amount)+'</td><td>'+esc(d.note||"—")+'</td><td>'+esc(names[d.created_by]||"Member")+'</td></tr>').join(""):'<tr><td colspan="5" class="empty">No expenses have been recorded yet.</td></tr>';
    status("fundsStatus",donations.length+" donation record(s) · "+expenses.length+" expense record(s).");
  }
  $("fundDonationForm").addEventListener("submit",async ev=>{
    ev.preventDefault();
    if(!state.session||!state.canAccessFunds){status("fundFormStatus","You do not have permission to add donations.","error");return;}
    const donor_name=$("fundDonorName").value.trim(),amount=Number($("fundAmount").value),donation_date=$("fundDate").value,note=$("fundNote").value.trim();
    if(!donor_name||!Number.isFinite(amount)||amount<=0||!donation_date){status("fundFormStatus","Enter a donor, valid positive amount, and date.","error");return;}
    const btn=ev.submitter;if(btn)btn.disabled=true;
    const {error}=await client.from("bpc_fund_donations").insert({donor_name,amount,donation_date,note:note||null,created_by:state.session.user.id});
    if(error)status("fundFormStatus",error.message,"error");
    else{$("fundDonationForm").reset();$("fundDate").value=new Date().toISOString().slice(0,10);status("fundFormStatus","Donation saved.");await loadFundsPage();}
    if(btn)btn.disabled=false;
  });
  $("fundExpenseForm").addEventListener("submit",async ev=>{
    ev.preventDefault();
    if(!state.session||!state.isAdmin){status("fundExpenseStatus","Only administrators can record fund expenses.","error");return;}
    const description=$("fundExpenseDescription").value.trim(),amount=Number($("fundExpenseAmount").value),expense_date=$("fundExpenseDate").value,note=$("fundExpenseNote").value.trim();
    if(!description||!Number.isFinite(amount)||amount<=0||!expense_date){status("fundExpenseStatus","Enter a description, valid positive amount, and date.","error");return;}
    const btn=ev.submitter;if(btn)btn.disabled=true;
    const {error}=await client.from("bpc_fund_expenses").insert({description,amount,expense_date,note:note||null,created_by:state.session.user.id});
    if(error)status("fundExpenseStatus",error.message,"error");
    else{$("fundExpenseForm").reset();$("fundExpenseDate").value=new Date().toISOString().slice(0,10);status("fundExpenseStatus","Expense saved.");await loadFundsPage();}
    if(btn)btn.disabled=false;
  });
  $("refreshFunds").addEventListener("click",loadFundsPage);

  $("officialEditorAssignForm").addEventListener("submit",async ev=>{
    ev.preventDefault();if(!state.isAdmin){status("officialEditorStatus","Only a full website admin can assign the page editor.","error");return;}
    const user_id=$("officialEditorAccount").value;if(!user_id){status("officialEditorStatus","Choose a registered account first.","error");return;}
    const {error}=await client.from("official_matches_editors").upsert({user_id,assigned_by:state.session.user.id},{onConflict:"user_id"});
    if(error){status("officialEditorStatus",error.message,"error");return;}toast("Official Matches editor assigned.");await loadOfficialPage();
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
      else{state.profile=null;state.player=null;state.isAdmin=false;state.canAccessFunds=false;}
      await refreshFundsAccess();
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
      await refreshFundsAccess();
      setAuthUI();
      if(recoveryHash && !state.session){
        status("authMessage","This recovery link could not establish a valid session. Request a fresh password reset email and open the newest link in the same browser.","error");
        showView("account");
      }
    }
    await loadMembers();await loadPublicPoster();await loadHomeBanner();
  }
  boot();
})();
