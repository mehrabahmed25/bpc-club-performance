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
  tnAdmin:false,
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
    if(name==="account"&&state.session&&!state.recoveryMode)name="profile";
    if(name==="funds"&&!state.canAccessFunds){toast("BPC Funds is restricted to authorized accounts.");name="home";}
    if(name==="player"){const cur=document.querySelector(".view:not(.hidden)");if(cur&&cur.id!=="view-player")state.pfFrom=cur.id.replace("view-","");}
    document.querySelectorAll(".view").forEach(v=>v.classList.add("hidden"));
    const target=$("view-"+name);if(target)target.classList.remove("hidden");
    document.querySelectorAll(".navlink").forEach(b=>b.classList.toggle("active",b.dataset.view===name));
    $("nav").classList.remove("open");
    if(name==="home"){loadPublicPoster();loadHomeBanner();loadHomeLegends();}
    else { $("uclPosterSection").classList.add("hidden"); $("homeBannerSection").classList.add("hidden"); if(posterTimer){clearInterval(posterTimer);posterTimer=null;} }
    if(name==="leaderboard")loadLeaderboard();
    if(name==="h2h")loadH2hPage();
    if(name==="player")renderPlayerPage();
    if(name==="weekly")loadWeekly();
    if(name==="history")loadHistory();
    if(name==="official")loadOfficialPage();
    if(name==="tournaments"){tnOpen=null;applyTnVisibility();loadTournaments();}
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
          if(result.data.session){state.session=result.data.session;await loadIdentity();setAuthUI();if(state.session){toast("Account created.");showView("profile");}else showView("account");}
        }else{
          result=await client.auth.signInWithPassword({email,password});
          if(result.error)throw result.error;
          state.session=result.data.session;await loadIdentity();setAuthUI();if(state.session){toast("Welcome back.");showView("profile");}else showView("account");
        }
      }catch(err){status("authMessage",err.message||String(err),"error");}
      finally{if($("authSubmit"))$("authSubmit").disabled=false;}
    };
    $("toggleAuth").onclick=()=>{state.signup=!state.signup;setAuthUI();};
  }
  $("dbPhotoPick").addEventListener("click",()=>$("dbPhotoFile").click());
  $("dbAvatar").addEventListener("click",()=>$("dbPhotoFile").click());
  $("dbPhotoFile").addEventListener("change",e=>{const f=e.target.files[0];e.target.value="";changePhoto(f);});
  $("dbPhotoRemove").addEventListener("click",removePhoto);
  $("dbSignOut").addEventListener("click",()=>signOut());
  async function signOut(){await client.auth.signOut();state.session=null;state.profile=null;state.player=null;state.isAdmin=false;state.tnAdmin=false;state.isTnManager=false;setAuthUI();toast("Signed out.");showView("home");}
  async function loadIdentity(){
    if(!client||!state.session)return;
    const uid=state.session.user.id;
    const [pr,pl]=await Promise.all([
      client.from("profiles").select("*").eq("id",uid).maybeSingle(),
      client.from("players").select("*").eq("user_id",uid).maybeSingle()
    ]);
    state.profile=pr.data||{display_name:state.session.user.email,role:"player"};
    state.player=pl.data||null;state.isAdmin=state.profile.role==="admin";
    if(state.player&&state.player.removed_at&&!state.isAdmin){
      await client.auth.signOut();state.session=null;state.profile=null;state.player=null;state.isAdmin=false;state.tnAdmin=false;state.isTnManager=false;
      toast("This account has been removed by an admin.");return;
    }
    state.isTnManager=false;
    if(!state.isAdmin){const mg=await client.from("tournament_managers").select("user_id").eq("user_id",uid).maybeSingle();state.isTnManager=!mg.error&&!!mg.data;}
    state.tnAdmin=state.isAdmin||state.isTnManager;
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
    const wantMoves=month===monthNow;
    const [{data,error},prev]=await Promise.all([client.rpc("get_leaderboard",{p_month:monthDate(month)}),wantMoves?client.rpc("get_leaderboard_asof",{p_month:monthDate(month),p_cutoff:ymd(addDays(new Date(),-7))}):Promise.resolve({data:null}),ensureAvatars()]);
    if(error){status("leaderboardStatus",error.message,"error");return;}
    const moves=rankMoves(data,prev&&prev.data);
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
      return '<tr><td class="'+(r.rank<=3?'rank-'+r.rank:'')+'"><span class="rk">'+r.rank+'</span>'+moveHtml(moves[r.player_id])+'</td><td><div class="player-cell link-player" data-player="'+esc(r.player_id)+'"><span class="avatar"'+av(r.player_name,{id:r.player_id})+'>'+esc((r.player_name||"?").split(/\\s+/).map(x=>x[0]).slice(0,2).join("").toUpperCase())+'</span>'+esc(r.player_name)+'</div></td><td>'+r.matches_played+'</td><td>'+r.wins+'</td><td>'+r.draws+'</td><td>'+r.losses+'</td><td>'+r.goals_for+'</td><td>'+r.goals_against+'</td><td>'+signed(r.goal_difference)+'</td><td class="points">'+r.points+'</td><td>'+r.cobeg_opponents+'/5</td><td>'+total+'/25</td><td><span class="pill '+(eligible?'good':'')+'">'+(eligible?'Eligible':'In progress')+'</span></td></tr>';
    }).join("");
    renderPodium(data);
  }
  function renderPodium(rows){
    const el=$("lbPodium");if(!el)return;
    const top=(rows||[]).filter(r=>Number(r.matches_played)>0).slice(0,3);
    if(top.length<3){el.classList.add("hidden");el.innerHTML="";return;}
    const slot=(r,i)=>'<div class="pod pod-'+(i+1)+' link-player" data-player="'+esc(r.player_id)+'"><span class="pod-rank">'+(i+1)+'</span><span class="pod-avatar"'+av(r.player_name,{id:r.player_id})+'>'+esc(initials(r.player_name))+'</span><b class="pod-name">'+esc(r.player_name)+'</b><span class="pod-pts">'+esc(r.points)+'<small> pts</small></span><span class="pod-rec">'+esc(r.wins)+'W '+esc(r.draws)+'D '+esc(r.losses)+'L · GD '+signed(Number(r.goal_difference)||0)+'</span></div>';
    el.innerHTML=[1,0,2].map(i=>slot(top[i],i)).join("");
    el.classList.remove("hidden");
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
  async function loadMyTournamentMatches(){
    const box=$("myTournamentSection"),next=$("dbNext");if(!box)return;
    const nextEmpty=(title,text)=>{if(next)next.innerHTML='<small>Your next match</small><div class="db-vs">'+esc(title)+'</div><p class="db-sub">'+esc(text)+'</p><button type="button" class="primary" id="dbBrowse">Browse tournaments</button>';$("dbBrowse")?.addEventListener("click",()=>showView("tournaments"));};
    if(!client||!state.session){box.classList.add("hidden");return;}
    const {data,error}=await client.rpc("tournament_my_matches");
    if(error){box.classList.add("hidden");nextEmpty("Tournament fixtures unavailable","They will appear here once the tournament system is ready.");return;}
    const rows=data||[];
    const upcoming=rows.filter(r=>!["approved","completed","bye"].includes(r.status));
    const results=rows.filter(r=>["approved","completed"].includes(r.status)).sort((a,b)=>new Date(b.approved_at||0)-new Date(a.approved_at||0));
    // hero: the match that needs attention first
    const waiting=upcoming.filter(r=>["scheduled","rejected"].includes(r.status)).sort((a,b)=>(a.deadline_at?new Date(a.deadline_at):Infinity)-(b.deadline_at?new Date(b.deadline_at):Infinity));
    if(next){
      const n=waiting[0];
      if(n){
        const left=n.deadline_at?timeLeft(n.deadline_at):null;
        const when=!n.deadline_at?'No deadline set':left?'Score due in '+left:'Deadline passed, contact an admin';
        next.innerHTML='<small>Your next match, '+esc(n.tournament_name)+'</small><div class="db-vs"><b>'+esc(n.my_name)+'</b><em>vs</em><b>'+esc(n.opponent_name||"TBD")+'</b></div><div class="db-when'+(n.deadline_at&&!left?' late':'')+'">'+esc(when)+'</div>'+(n.can_submit?'<button type="button" class="primary" id="dbJump">Enter the score</button>':'');
        $("dbJump")?.addEventListener("click",()=>$("myTournamentUpcoming").scrollIntoView({behavior:"smooth",block:"start"}));
      }else if(upcoming.length)nextEmpty("Nothing left for you to send",upcoming[0].note||"Your latest score is with the admins.");
      else nextEmpty("Nothing waiting for you","When a tournament fixture is published it shows up here with its deadline.");
    }
    if(!rows.length){box.classList.add("hidden");return;}
    box.classList.remove("hidden");status("myTournamentStatus","");
    // which side of the fixture the player is on, so each score goes to the right column
    const sideMap={};
    const submittable=upcoming.filter(r=>r.can_submit).map(r=>r.match_id);
    if(submittable.length){const q=await client.from("tournament_matches").select("id,participant_a_id").in("id",submittable);(q.data||[]).forEach(m=>{const r=rows.find(x=>x.match_id===m.id);if(r)sideMap[m.id]=m.participant_a_id===r.my_participant_id;});}
    const where=r=>esc(r.stage_name)+(r.group_name?', group '+esc(r.group_name):'')+', round '+r.round_number;
    $("myTournamentUpcoming").innerHTML=upcoming.length?'<div class="db-upcoming">'+upcoming.map(r=>{
      const mode=r.can_submit?"player":"view";
      const iAmA=mode==="player"?sideMap[r.match_id]!==false:true;
      const me={name:r.my_name,you:true},opp={name:r.opponent_name||"TBD",you:false};
      const open=["scheduled","rejected"].includes(r.status);
      return renderBoard({id:r.match_id,mode,mine:true,done:false,left:iAmA?me:opp,right:iAmA?opp:me,
        head:'<div class="db-up-head"><b>'+esc(r.tournament_name)+'</b><span class="small">'+where(r)+'</span></div>',
        foot:(open?dueChip(r.deadline_at,true):'')+(r.note?'<span class="db-note">'+esc(r.note)+'</span>':'')+'<button type="button" class="secondary" data-my-open="'+esc(r.tournament_id)+'">View tournament</button>'});
    }).join("")+'</div>':'<div class="tn-empty">No upcoming tournament matches right now.</div>';
    const label={win:"Win",draw:"Draw",loss:"Loss"};
    $("myTournamentResults").innerHTML=results.length?'<div class="db-results">'+results.map(r=>'<article class="db-result '+esc(r.outcome)+'"><div class="db-result-main"><span class="small">'+esc(r.tournament_name)+', '+where(r)+'</span><b>'+esc(r.my_name)+'<span class="db-score">'+esc(r.my_score)+' – '+esc(r.opponent_score)+'</span>'+esc(r.opponent_name||"")+'</b></div><div class="db-result-side"><span class="pill '+(r.outcome==="win"?"good":r.outcome==="loss"?"bad":"pending")+'">'+esc(label[r.outcome]||r.outcome)+'</span><span>'+(r.approved_at?'Approved '+esc(new Date(r.approved_at).toLocaleDateString([],{dateStyle:"medium"})):'')+'</span></div></article>').join("")+'</div>':'<div class="tn-empty">No approved tournament results yet.</div>';
    bindScoreForms(box,()=>{toast("Score submitted. An admin will review it.");loadMyTournamentMatches();},msg=>{status("myTournamentStatus",msg,"error");toast(msg);});
    box.querySelectorAll("[data-my-open]").forEach(b=>b.onclick=async()=>{showView("tournaments");await openTournament(b.dataset.myOpen);});
  }
  async function loadProfile(){
    if(!client||!state.session){showView("account");return;}
    loadMyTournamentMatches();
    const dbName=state.player?.display_name||"";$("profileHeading").textContent=dbName?"Welcome back, "+dbName.split(" ")[0]:"Your dashboard";paintDbAvatar();$("dbSub").textContent="Fixtures, deadlines and results in one place.";
    // Same source as the leaderboard, so the dashboard always agrees with it. This counts matches
    // you submitted AND matches another member logged against you.
    const month=$("monthPicker").value||monthNow,pm=monthDate(month);
    $("dbMonthHead").textContent="Friendly matches in "+new Date(month+"-01T12:00:00").toLocaleDateString(undefined,{month:"long",year:"numeric"});
    const [lb,ct,mine]=await Promise.all([
      client.rpc("get_leaderboard",{p_month:pm}),
      client.rpc("get_cobeg_match_totals",{p_month:pm}),
      client.rpc("get_my_month_stats",{p_month:pm})
    ]);
    if(lb.error){$("profileStats").innerHTML='<div class="panel">'+esc(lb.error.message)+'</div>';return;}
    const me=(lb.data||[]).find(r=>r.player_id===state.player?.id);
    if(!me){$("profileStats").innerHTML="";$("eligibilityBars").innerHTML="";$("eligibilityText").textContent="Your player profile was not found. Contact an admin.";return;}
    const n=v=>Number(v)||0,played=n(me.matches_played),opps=n(me.cobeg_opponents);
    const cobegMatches=n((ct.data||[]).find(r=>r.player_id===me.player_id)?.total_mp_vs_cobeg_xi);
    const pending=mine.error?0:n(mine.data?.[0]?.pending_matches);
    const vals=[["Matches",played,""],["Wins",n(me.wins),"good"],["Draws",n(me.draws),""],["Losses",n(me.losses),"bad"],["Goals for",n(me.goals_for),""],["Goals against",n(me.goals_against),""],["Goal difference",signed(n(me.goal_difference)),""],["Points",n(me.points),"main"]];
    $("profileStats").innerHTML=vals.map(x=>'<div class="stat-card'+(x[2]?' tone-'+x[2]:'')+'"><small>'+x[0]+'</small><b>'+x[1]+'</b></div>').join("");
    // Award rules: 40+ matches in the month, of which 25+ are against COBEG XI players, covering 5+ different COBEG XI players.
    const need={total:40,cobeg:25,opps:5};
    const bar=(label,v,max)=>'<div class="db-bar-row"><span><b>'+v+'</b> of '+max+' '+label+'</span><div class="tn-track"><span class="'+(v>=max?'done':'')+'" style="width:'+Math.round(Math.min(v,max)/max*100)+'%"></span></div></div>';
    $("eligibilityBars").innerHTML=bar("matches played this month",played,need.total)+bar("matches against COBEG XI players",cobegMatches,need.cobeg)+bar("different COBEG XI players faced",opps,need.opps);
    const eligible=played>=need.total&&cobegMatches>=need.cobeg&&opps>=need.opps;
    const gaps=[];
    if(played<need.total)gaps.push((need.total-played)+" more match"+(need.total-played===1?"":"es")+" in total");
    if(cobegMatches<need.cobeg)gaps.push((need.cobeg-cobegMatches)+" more match"+(need.cobeg-cobegMatches===1?"":"es")+" against COBEG XI players");
    if(opps<need.opps)gaps.push((need.opps-opps)+" more different COBEG XI player"+(need.opps-opps===1?"":"s"));
    $("eligibilityText").textContent=(eligible?"You are currently eligible for the monthly award.":"To be eligible you still need "+gaps.join(", ")+".")+" The award needs "+need.total+" matches in the month, including at least "+need.cobeg+" against COBEG XI players and "+need.opps+" different COBEG XI players."+(pending?" Pending matches this month: "+pending+".":"");
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
  .select("id,user_id,display_name,active,created_at,removed_at")
  .order("created_at", { ascending: false })
  .limit(300);

if (ps.error) {
  status("adminStatus", ps.error.message, "error");
  return;
}

const allPlayers = ps.data || [];
const removedCount = allPlayers.filter(p => p.removed_at).length;
const shown = allPlayers.filter(p => showRemovedPlayers || !p.removed_at);
const bar = $("playersRemovedBar");
if (bar) {
  bar.hidden = !removedCount;
  bar.innerHTML = '<span>' + removedCount + ' removed player' + (removedCount === 1 ? '' : 's') + ' hidden from the live site.</span>' +
    '<button type="button" class="secondary" id="toggleRemovedPlayers">' + (showRemovedPlayers ? 'Hide removed' : 'Show removed') + '</button>';
  const tg = $("toggleRemovedPlayers");
  if (tg) tg.onclick = () => { showRemovedPlayers = !showRemovedPlayers; loadAdmin(); };
}

$("playersBody").innerHTML = shown.map(p =>
  '<tr' + (p.removed_at ? ' class="is-removed"' : '') + '>' +
    '<td>' + esc(p.display_name) + '</td>' +
    '<td><span class="pill ' + (p.removed_at ? 'bad' : p.active ? 'good' : 'bad') + '">' +
      (p.removed_at ? 'Removed' : p.active ? 'Active' : 'Inactive') +
    '</span></td>' +
    '<td>' + prettyDate(p.created_at?.slice(0, 10)) + '</td>' +
    '<td class="player-actions">' +
      '<button type="button" class="recovery-btn" data-recover="' + esc(p.id) + '">Recover Account</button> ' +
      (p.removed_at
        ? '<button type="button" class="recovery-btn" data-restore="' + esc(p.id) + '">Restore</button>'
        : (p.user_id === state.session?.user?.id ? '' : '<button type="button" class="recovery-btn danger-btn" data-remove="' + esc(p.id) + '">Remove</button>')) +
    '</td>' +
  '</tr>'
).join("") || '<tr><td colspan="4" class="small">No players yet.</td></tr>';
    $("playersBody").querySelectorAll("[data-recover]").forEach(button=>{
      button.onclick=()=>recoverPlayerAccount(button.dataset.recover,button);
    });
    $("playersBody").querySelectorAll("[data-remove]").forEach(button=>{
      button.onclick=()=>setPlayerRemoved(button.dataset.remove,true,button);
    });
    $("playersBody").querySelectorAll("[data-restore]").forEach(button=>{
      button.onclick=()=>setPlayerRemoved(button.dataset.restore,false,button);
    });
  }

  var showRemovedPlayers=false;
  async function setPlayerRemoved(playerId,remove,button){
    if(!state.isAdmin||!state.session)return;
    const name=button.closest("tr")?.querySelector("td")?.textContent?.trim()||"this player";
    const msg=remove
      ?"Remove "+name+"?\n\nThey will disappear from the leaderboard, player lists and tournaments on the live site, and will be signed out. All their matches and data are kept, and you can restore them later."
      :"Restore "+name+"? They will appear on the live site again and can sign in.";
    if(!confirm(msg))return;
    button.disabled=true;
    const {error}=await client.rpc(remove?"admin_remove_player":"admin_restore_player",{p_player_id:playerId});
    if(error){button.disabled=false;status("adminStatus",error.message,"error");return;}
    status("adminStatus",name+(remove?" was removed from the live site.":" was restored."),"success");
    toast(remove?"Player removed.":"Player restored.");
    loadAdmin();
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


  // Tournament module: separate tables only; never writes to friendly-match or funds tables.
  function tournamentSlug(value){
    return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,70);
  }
  function tournamentDate(value){
    if(!value)return "Not set";
    const d=new Date(value);return Number.isNaN(d.getTime())?"Not set":d.toLocaleString();
  }
  // Tournament managers: accounts a full admin allows to run the Tournaments page only.
  async function loadTnManagers(){
    if(!state.isAdmin||!client)return;
    const [acc,acs]=await Promise.all([
      client.from("players").select("user_id,display_name").not("user_id","is",null).order("display_name"),
      client.from("tournament_managers").select("user_id,granted_at").order("granted_at",{ascending:true})
    ]);
    if(acc.error||acs.error){status("tnManagersStatus",(acc.error||acs.error).message,"error");return;}
    const accounts=acc.data||[],granted=acs.data||[],names={};
    accounts.forEach(a=>{names[a.user_id]=a.display_name||"Registered account";});
    $("tnManagerAccount").innerHTML='<option value="">Choose a registered account</option>'+accounts.filter(a=>!granted.some(g=>g.user_id===a.user_id)).map(a=>'<option value="'+esc(a.user_id)+'">'+esc(a.display_name||"Registered account")+'</option>').join("");
    $("tnManagersCount").textContent=granted.length;
    $("tnManagersList").innerHTML=granted.length?granted.map(g=>{const nm=names[g.user_id]||"Registered account";return '<div class="tn-mgr"><span class="tn-avatar" aria-hidden="true"'+av(nm,{uid:g.user_id})+'>'+esc(initials(nm))+'</span><div><b>'+esc(nm)+'</b><span class="small">Manager since '+esc(tournamentDate(g.granted_at))+'</span></div><button type="button" class="reject-btn" data-tn-mgr-revoke="'+esc(g.user_id)+'">Remove access</button></div>';}).join(""):'<div class="tn-empty">No managers yet. Full admins always have access.</div>';
    $("tnManagersList").querySelectorAll("[data-tn-mgr-revoke]").forEach(b=>b.addEventListener("click",async()=>{
      if(!state.isAdmin)return;
      const uid=b.dataset.tnMgrRevoke;
      if(!confirm("Remove tournament access for "+(names[uid]||"this account")+"?"))return;
      const {error}=await client.rpc("tournament_admin_set_manager",{p_user_id:uid,p_grant:false});
      if(error){status("tnManagersStatus",error.message,"error");return;}
      toast("Tournament access removed.");await loadTnManagers();
    }));
  }
  $("tnManagerForm").addEventListener("submit",async ev=>{
    ev.preventDefault();
    if(!state.isAdmin){status("tnManagersStatus","Only a full admin can grant tournament access.","error");return;}
    const uid=$("tnManagerAccount").value;
    if(!uid){status("tnManagersStatus","Choose an account first.","error");return;}
    const {error}=await client.rpc("tournament_admin_set_manager",{p_user_id:uid,p_grant:true});
    if(error){status("tnManagersStatus",error.message,"error");return;}
    status("tnManagersStatus","");toast("Tournament access granted.");await loadTnManagers();
  });
  function applyTnVisibility(){
    const open=!!tnOpen;
    $("tournamentDetail").classList.toggle("hidden",!open);
    $("tournamentList").classList.toggle("hidden",open);
    $("tournamentTabs").classList.toggle("hidden",open||!tnRows.length);
    $("tournamentAdminPanel").classList.toggle("hidden",open||!state.tnAdmin);
    $("tnManagersPanel").classList.toggle("hidden",open||!state.isAdmin);
  }
  function tournamentCard(t){
    const cat=tnCategory(t),c=tnCounts[t.id]||{confirmed:0,pending:0},limit=t.participant_limit,id=esc(t.id);
    const players=(limit?c.confirmed+' of '+limit:c.confirmed)+(c.confirmed===1&&!limit?' player':' players');
    const fill=limit?'<div class="tn-track" role="img" aria-label="'+c.confirmed+' of '+limit+' places filled"><span style="width:'+Math.min(100,Math.round(c.confirmed/limit*100))+'%"></span></div>':'';
    const reg=t.status==="registration_open"&&t.registration_deadline?'<span>Registration closes '+esc(tournamentDate(t.registration_deadline))+'</span>':'';
    let admin="";
    if(state.tnAdmin){
      if(t.status==="draft")admin='<button type="button" class="primary" data-tournament-publish="'+id+'">Open registration</button>';
      else if(cat==="live")admin='<button type="button" class="secondary" data-tn-end="'+id+'">End tournament</button><button type="button" class="secondary quiet" data-tn-archive="'+id+'">Archive</button>';
      else if(cat==="finished")admin='<button type="button" class="secondary quiet" data-tn-archive="'+id+'">Archive</button>';
      else if(cat==="archived")admin='<button type="button" class="secondary" data-tn-restore="'+id+'">Restore</button>'+(t.hidden_at?'<button type="button" class="secondary" data-tn-unhide="'+id+'">Unhide</button>':'<button type="button" class="secondary quiet" data-tn-hide="'+id+'">Hide</button>');
    }
    return '<article class="tn-card tn-'+cat+' tn-st-'+esc(t.status)+(t.hidden_at?' is-hidden':'')+'"><div class="tn-card-top"><span class="tn-glyph">'+tnGlyph(t.format)+'</span><div class="tn-card-title"><h3>'+esc(t.name)+'</h3><div class="tn-chips"><span class="tn-chip">'+esc(TN_FORMAT[t.format]||t.format)+'</span><span class="tn-chip">'+(t.competition_type==="team"?"Team":"Individual")+'</span>'+(state.tnAdmin&&c.pending?'<span class="tn-chip warn">'+c.pending+' waiting for approval</span>':'')+'</div></div>'+tnStateHtml(t.status)+'</div>'
      +'<p class="tn-desc">'+esc(t.description||"No description yet.")+'</p><div class="tn-fill"><span><b>'+esc(players)+'</b></span>'+fill+reg+'</div>'
      +'<div class="tn-actions"><button type="button" class="'+(t.status==="draft"?"secondary":"primary")+'" data-tournament-open="'+id+'">View tournament</button>'+admin+'</div></article>';
  }
  function renderTournamentList(){
    const groups={live:[],finished:[],archived:[],drafts:[]};
    tnRows.forEach(t=>groups[tnCategory(t)].push(t));
    const hiddenCount=groups.archived.filter(t=>t.hidden_at).length;
    if(!tnShowHidden)groups.archived=groups.archived.filter(t=>!t.hidden_at);
    const tabs=[["live","Live"],["finished","Finished"]];
    if(state.tnAdmin)tabs.push(["archived","Archived"]);
    if(state.tnAdmin&&groups.drafts.length)tabs.push(["drafts","Drafts"]);
    if(!tabs.some(x=>x[0]===tnFilter))tnFilter="live";
    $("tournamentTabs").innerHTML=tabs.map(x=>'<button type="button" role="tab" class="tn-tab" aria-selected="'+(x[0]===tnFilter)+'" data-tn-tab="'+x[0]+'">'+x[1]+'<i>'+groups[x[0]].length+'</i></button>').join("");
    const empty={live:'No live tournaments right now.'+(state.tnAdmin?' Create one above to get started.':' Check back soon.'),finished:'Nothing has finished yet. Ended tournaments and their results will show up here.',archived:'No archived tournaments.',drafts:'No drafts.'}[tnFilter];
    const list=groups[tnFilter];
    const hideBar=tnFilter==="archived"&&hiddenCount?'<div class="tn-hidebar"><span>'+(tnShowHidden?"Showing "+hiddenCount+" hidden tournament"+(hiddenCount===1?"":"s")+".":hiddenCount+" tournament"+(hiddenCount===1?" is":"s are")+" hidden.")+'</span><button type="button" class="secondary" data-tn-togglehidden>'+(tnShowHidden?"Hide them again":"Show hidden")+'</button></div>':'';
    $("tournamentList").innerHTML=hideBar+(list.length?list.map(tournamentCard).join(""):'<div class="tn-empty" style="grid-column:1/-1">'+esc(empty)+'</div>');
    $("tournamentList").querySelector("[data-tn-togglehidden]")?.addEventListener("click",()=>{tnShowHidden=!tnShowHidden;renderTournamentList();});
    $("tournamentTabs").querySelectorAll("[data-tn-tab]").forEach(b=>b.addEventListener("click",()=>{tnFilter=b.dataset.tnTab;renderTournamentList();}));
    const L=$("tournamentList");
    L.querySelectorAll("[data-tournament-open]").forEach(b=>b.addEventListener("click",()=>openTournament(b.dataset.tournamentOpen)));
    L.querySelectorAll("[data-tournament-publish]").forEach(b=>b.addEventListener("click",()=>publishTournament(b.dataset.tournamentPublish)));
    const row=id=>tnRows.find(x=>x.id===id);
    L.querySelectorAll("[data-tn-end]").forEach(b=>b.addEventListener("click",()=>tnLifecycle(row(b.dataset.tnEnd),"completed")));
    L.querySelectorAll("[data-tn-archive]").forEach(b=>b.addEventListener("click",()=>tnLifecycle(row(b.dataset.tnArchive),"archived")));
    L.querySelectorAll("[data-tn-hide]").forEach(b=>b.addEventListener("click",()=>tnHide(row(b.dataset.tnHide),true)));
    L.querySelectorAll("[data-tn-unhide]").forEach(b=>b.addEventListener("click",()=>tnHide(row(b.dataset.tnUnhide),false)));
    L.querySelectorAll("[data-tn-restore]").forEach(b=>b.addEventListener("click",()=>tnLifecycle(row(b.dataset.tnRestore),"completed")));
  }
  // End, archive or restore a tournament (admin). Records are kept in every case.
  // Hide or unhide an archived tournament (nothing is deleted).
  async function tnHide(t,hide){
    if(!state.tnAdmin||!t)return;
    const {error}=await client.rpc("tournament_admin_set_hidden",{p_tournament_id:t.id,p_hidden:hide});
    if(error){const m=/could not find the function|schema cache/i.test(error.message)?"Hiding is not enabled in the database yet.":error.message;status("tournamentStatus",m,"error");toast(m);return;}
    toast(hide?"Hidden. Use “Show hidden” in the Archived tab to bring it back.":"Tournament is visible again.");
    tnOpen=null;tnFilter="archived";await loadTournaments();
  }
  async function tnLifecycle(t,target){
    if(!state.tnAdmin||!t)return;
    const restoring=t.status==="archived"&&target==="completed";
    const msg=restoring?"Restore “"+t.name+"” to the Finished tab?"
      :target==="completed"?"End “"+t.name+"”? Results and history stay visible, but new fixtures and score submissions close. You can archive it afterwards."
      :"Archive “"+t.name+"”? It moves to the Archived tab. All records are kept and you can restore it later.";
    if(!confirm(msg))return;
    const {error}=await client.rpc("tournament_admin_set_status",{p_tournament_id:t.id,p_status:target,p_reason:null});
    if(error){status("tournamentStatus",error.message,"error");toast(error.message);return;}
    toast(target==="archived"?"Tournament archived.":restoring?"Tournament restored.":"Tournament ended.");
    tnFilter=target==="archived"?"archived":"finished";
    tnOpen=null;
    await loadTournaments();
  }
  async function loadTournaments(){
    await ensureAvatars();
    if(!client){status("tournamentStatus","Supabase connection is not configured.","error");return;}
    status("tournamentStatus","Loading tournaments…");
    const {data,error}=await client.from("tournament_tournaments")
      .select("id,name,slug,description,competition_type,format,status,visibility,registration_mode,registration_requires_approval,registration_deadline,participant_limit,score_workflow,created_at,hidden_at")
      .order("created_at",{ascending:false});
    if(error){
      $("tournamentList").innerHTML='<div class="panel soft">Tournament storage is not ready yet. An administrator must run the reviewed BPC Tournaments SQL migration in Supabase.</div>';
      status("tournamentStatus",error.message,"error");return;
    }
    tnRows=data||[];tnCounts={};
    if(tnRows.length){
      const q=await client.from("tournament_participants").select("tournament_id,status").in("tournament_id",tnRows.map(t=>t.id));
      (q.data||[]).forEach(p=>{const c=tnCounts[p.tournament_id]||(tnCounts[p.tournament_id]={confirmed:0,pending:0});if(p.status==="confirmed")c.confirmed++;else if(p.status==="pending")c.pending++;});
    }
    status("tournamentStatus","");
    renderTournamentList();
    applyTnVisibility();
    if(state.isAdmin)loadTnManagers();
  }
  // ---- Create-tournament wizard (admins and managers) -------------------------------
  const TN_PICK_FORMAT=[["round_robin","Round robin","Everyone plays everyone. Best for smaller fields."],["knockout","Knockout","Win to advance. Lose and you are out."],["group_knockout","Groups, then knockout","A group stage first, then knockout rounds for the qualifiers."],["swiss","Swiss","A fixed number of rounds, paired by current points."]];
  const TN_PICK_FLOW=[["participant_admin","Players submit, admin approves","Either player sends the score and an admin approves it. Recommended."],["participant_opponent_admin","Players submit, opponent confirms, admin approves","The other player must confirm the score before the admin sees it."],["admin_entered","Admin enters every score","Players cannot submit. Admins type the scores in."]];
  const TN_PICK_JOIN=[["both","Players sign up, and I can add players","Open sign-ups, plus you can add anyone yourself."],["self","Players sign up themselves","Players join from the tournament page."],["admin","I add the players","Sign-ups stay closed. You build the list."]];
  const TN_PICK_SEE=[["all_members","Everyone signed in","Every member can find and follow it."],["participants_admins","Only its players and admins","Hidden from members who are not taking part."]];
  const tnOpt=(name,val,title,text,on)=>'<label class="tn-opt"><input type="radio" name="'+name+'" value="'+esc(val)+'"'+(on?' checked':'')+'><span><b>'+esc(title)+'</b><small>'+esc(text)+'</small></span></label>';
  function openTnWizard(){
    if(!state.tnAdmin||!state.session)return;
    const d={name:"",description:"",type:"individual",format:"round_robin",join:"both",approval:false,deadline:"",limit:"",see:"all_members",flow:"participant_admin"};
    const STEPS=["Basics","Players","Scores"];let step=0,busy=false;
    const ov=document.createElement("div");ov.className="modal-overlay";
    ov.innerHTML='<div class="modal-box tn-wiz" role="dialog" aria-modal="true" aria-labelledby="wizTitle"><div class="tn-wiz-head"><div><h3 id="wizTitle">New tournament</h3><p class="small" id="wizSub"></p></div><button type="button" class="tn-wiz-x" id="wizX" aria-label="Close">&times;</button></div><ol class="tn-wiz-steps" id="wizSteps"></ol><div class="tn-wiz-body" id="wizBody"></div><div class="status" id="wizErr" role="alert"></div><div class="tn-wiz-foot" id="wizFoot"></div></div>';
    document.body.appendChild(ov);
    const $w=id=>ov.querySelector("#"+id);
    const close=()=>{ov.remove();document.removeEventListener("keydown",onKey);};
    const onKey=e=>{if(e.key==="Escape"&&!busy)close();};
    document.addEventListener("keydown",onKey);
    $w("wizX").onclick=()=>{if(!busy)close();};
    const err=m=>{$w("wizErr").textContent=m||"";};
    const summary=()=>{
      const f=TN_PICK_FORMAT.find(x=>x[0]===d.format)[1],fl=TN_PICK_FLOW.find(x=>x[0]===d.flow)[1],j=TN_PICK_JOIN.find(x=>x[0]===d.join)[1];
      const rows=[["Name",d.name.trim()],["Type",d.type==="team"?"Teams":"Individual players"],["Format",f],["Joining",j+(d.join!=="admin"&&d.approval?", approved by you":"")],["Visible to",TN_PICK_SEE.find(x=>x[0]===d.see)[1]],["Scores",fl]];
      if(d.join!=="admin"&&d.deadline)rows.push(["Sign-ups close",tournamentDate(new Date(d.deadline).toISOString())]);
      if(d.limit)rows.push(["Player limit",d.limit]);
      return '<dl class="tn-sum">'+rows.map(r=>'<div><dt>'+esc(r[0])+'</dt><dd>'+esc(r[1])+'</dd></div>').join("")+'</dl>';
    };
    function render(){
      err("");
      $w("wizSteps").innerHTML=STEPS.map((x,i)=>'<li class="'+(i===step?'on':i<step?'done':'')+'"><span>'+(i<step?'&#10003;':i+1)+'</span>'+x+'</li>').join("");
      $w("wizSub").textContent=["Name it and pick how it is played.","Choose who can join and how.","Choose how scores are reported, then review."][step];
      let body="";
      if(step===0){
        body='<label class="tn-field">Tournament name<input id="wName" maxlength="120" required placeholder="e.g. BPC Autumn Cup" value="'+esc(d.name)+'"></label>'
          +'<label class="tn-field">Short description <em>(optional)</em><textarea id="wDesc" rows="2" maxlength="3000" placeholder="Rules, prizes, anything players should know">'+esc(d.description)+'</textarea></label>'
          +'<fieldset class="tn-set"><legend>Who plays</legend><div class="tn-opts two">'+tnOpt("wType","individual","Individual players","Each player enters on their own.",d.type==="individual")+tnOpt("wType","team","Teams","A player registers a team with a name.",d.type==="team")+'</div></fieldset>'
          +'<fieldset class="tn-set"><legend>Format</legend><div class="tn-opts two">'+TN_PICK_FORMAT.map(x=>tnOpt("wFormat",x[0],x[1],x[2],d.format===x[0])).join("")+'</div></fieldset>';
      }else if(step===1){
        body='<fieldset class="tn-set"><legend>How do players join?</legend><div class="tn-opts">'+TN_PICK_JOIN.map(x=>tnOpt("wJoin",x[0],x[1],x[2],d.join===x[0])).join("")+'</div></fieldset>'
          +'<div id="wSignup" class="'+(d.join==="admin"?'hidden':'')+'"><label class="tn-switch"><input type="checkbox" id="wApproval"'+(d.approval?' checked':'')+'><span><b>I approve each sign-up</b><small>Off means players are confirmed straight away.</small></span></label>'
          +'<div class="tn-two"><label class="tn-field">Sign-ups close <em>(optional)</em><input type="datetime-local" id="wDeadline" value="'+esc(d.deadline)+'"></label><label class="tn-field">Player limit <em>(optional)</em><input type="number" id="wLimit" min="2" step="1" placeholder="No limit" value="'+esc(d.limit)+'"></label></div></div>'
          +'<fieldset class="tn-set"><legend>Who can see it?</legend><div class="tn-opts two">'+TN_PICK_SEE.map(x=>tnOpt("wSee",x[0],x[1],x[2],d.see===x[0])).join("")+'</div></fieldset>';
      }else{
        body='<fieldset class="tn-set"><legend>How are scores reported?</legend><div class="tn-opts">'+TN_PICK_FLOW.map(x=>tnOpt("wFlow",x[0],x[1],x[2],d.flow===x[0])).join("")+'</div></fieldset><h4 class="tn-sum-h">Review</h4>'+summary()
          +(d.format==="group_knockout"?'<p class="small">Groups are set up once enough players are confirmed. The checklist on the tournament page will guide you.</p>':'');
      }
      $w("wizBody").innerHTML=body;
      $w("wizFoot").innerHTML=(step>0?'<button type="button" class="secondary" id="wBack">Back</button>':'<button type="button" class="secondary" id="wCancel">Cancel</button>')
        +(step<2?'<button type="button" class="primary" id="wNext">Continue</button>':'<button type="button" class="secondary" id="wDraft">Save as draft</button><button type="button" class="primary" id="wCreate">Create and open sign-ups</button>');
      wire();
      $w("wizBody").querySelector("input,textarea")?.focus({preventScroll:true});
    }
    function read(){
      const g=id=>$w(id);
      if(step===0){d.name=g("wName").value;d.description=g("wDesc").value;d.type=ov.querySelector('input[name=wType]:checked').value;d.format=ov.querySelector('input[name=wFormat]:checked').value;}
      else if(step===1){d.join=ov.querySelector('input[name=wJoin]:checked').value;d.approval=!!g("wApproval")?.checked;d.deadline=g("wDeadline")?.value||"";d.limit=g("wLimit")?.value||"";d.see=ov.querySelector('input[name=wSee]:checked').value;}
      else{d.flow=ov.querySelector('input[name=wFlow]:checked').value;}
    }
    function validate(){
      if(step===0){if(!tournamentSlug(d.name.trim())||d.name.trim().length<3)return "Give the tournament a name of at least 3 letters.";}
      if(step===1&&d.join!=="admin"){
        if(d.limit&&(!Number.isInteger(Number(d.limit))||Number(d.limit)<2))return "The player limit must be a whole number of 2 or more.";
        if(d.deadline&&new Date(d.deadline)<=new Date())return "Sign-ups must close at a time in the future.";
      }
      return "";
    }
    function wire(){
      $w("wCancel")&&($w("wCancel").onclick=()=>close());
      $w("wBack")&&($w("wBack").onclick=()=>{read();step--;render();});
      $w("wNext")&&($w("wNext").onclick=()=>{read();const m=validate();if(m){err(m);return;}step++;render();});
      ov.querySelectorAll('input[name=wJoin]').forEach(r=>r.addEventListener("change",()=>{$w("wSignup").classList.toggle("hidden",r.value==="admin"&&r.checked);}));
      ov.querySelectorAll('input[name=wFlow]').forEach(r=>r.addEventListener("change",()=>{read();$w("wizBody").querySelector(".tn-sum").outerHTML=summary();}));
      $w("wizBody").querySelectorAll("input[type=text],input:not([type]),textarea").forEach(i=>i.addEventListener("keydown",e=>{if(e.key==="Enter"&&i.tagName!=="TEXTAREA"){e.preventDefault();$w("wNext")?.click();}}));
      $w("wDraft")&&($w("wDraft").onclick=()=>submit(false));
      $w("wCreate")&&($w("wCreate").onclick=()=>submit(true));
    }
    async function submit(openNow){
      if(busy)return;read();const m=validate();if(m){err(m);return;}
      busy=true;ov.querySelectorAll("button").forEach(b=>b.disabled=true);err("");$w("wCreate")&&($w("wCreate").textContent="Creating…");
      const base=tournamentSlug(d.name.trim());
      const payload={name:d.name.trim(),slug:base,description:d.description.trim()||null,competition_type:d.type,format:d.format,status:"draft",visibility:d.see,registration_mode:d.join,registration_requires_approval:d.join!=="admin"&&d.approval,registration_deadline:d.join!=="admin"&&d.deadline?new Date(d.deadline).toISOString():null,participant_limit:d.join!=="admin"&&d.limit?Number(d.limit):null,score_workflow:d.flow,created_by:state.session.user.id};
      let res=await client.from("tournament_tournaments").insert(payload).select("id").single();
      if(res.error&&res.error.code==="23505"){payload.slug=base.slice(0,64)+"-"+Math.random().toString(36).slice(2,6);res=await client.from("tournament_tournaments").insert(payload).select("id").single();}
      if(res.error){busy=false;ov.querySelectorAll("button").forEach(b=>b.disabled=false);err(res.error.message);$w("wCreate")&&($w("wCreate").textContent="Create and open sign-ups");return;}
      const id=res.data.id;
      // Simple formats get their stage now; entrants are lined up automatically when round 1 is generated.
      if(d.format!=="group_knockout")await client.rpc("tournament_admin_setup_stages",{p_tournament_id:id,p_group_count:4});
      if(openNow)await client.from("tournament_tournaments").update({status:"registration_open",updated_at:new Date().toISOString()}).eq("id",id).eq("status","draft");
      close();toast(openNow?"Tournament created and sign-ups are open.":"Draft saved. Open sign-ups when you are ready.");
      await loadTournaments();await openTournament(id);
    }
    render();
  }
  $("tnCreateBtn").addEventListener("click",openTnWizard);
  // Group setup dialog: how many groups, and how players are split. Resolves to {groups,random} or null.
  function askGroups(confirmed){
    return new Promise(resolve=>{
      const ov=document.createElement("div");ov.className="modal-overlay";
      ov.innerHTML='<div class="modal-box" role="dialog" aria-modal="true"><h3>Set up groups</h3><p class="small">'+confirmed+' confirmed player'+(confirmed===1?"":"s")+'. Each group needs at least two.</p>'
        +'<label>Number of groups (2 to 8)<input id="agN" type="number" min="2" max="8" value="'+Math.min(8,Math.max(2,Math.min(4,Math.floor(confirmed/2))))+'"></label>'
        +'<fieldset class="tn-set"><legend>How are players split?</legend><div class="tn-opts">'
        +tnOpt("agMode","order","In sign-up order","Players are dealt into the groups one by one, so each group gets an even spread.",true)
        +tnOpt("agMode","random","Random draw","Players are placed in the groups at random. You can redraw until fixtures are generated.",false)+'</div></fieldset>'
        +'<div class="toolbar"><button type="button" class="primary" id="agOk">Set up groups</button><button type="button" class="secondary" id="agCancel">Cancel</button></div><div class="status" id="agErr" role="alert"></div></div>';
      document.body.appendChild(ov);
      const close=v=>{ov.remove();resolve(v);};
      ov.querySelector("#agCancel").onclick=()=>close(null);
      ov.addEventListener("click",e=>{if(e.target===ov)close(null);});
      ov.querySelector("#agOk").onclick=()=>{
        const n=Number(ov.querySelector("#agN").value);
        if(!Number.isInteger(n)||n<2||n>8){ov.querySelector("#agErr").textContent="Enter a whole number from 2 to 8.";return;}
        if(confirmed<n*2){ov.querySelector("#agErr").textContent="You need at least "+(n*2)+" confirmed players for "+n+" groups.";return;}
        close({groups:n,random:ov.querySelector("input[name=agMode]:checked").value==="random"});
      };
    });
  }
  // Small text/number prompt dialog. Resolves to the entered string, or null if cancelled.
  function askText(o){
    return new Promise(resolve=>{
      const ov=document.createElement("div");ov.className="modal-overlay";
      ov.innerHTML='<div class="modal-box" role="dialog" aria-modal="true"><h3>'+esc(o.title)+'</h3>'+(o.text?'<p class="small">'+esc(o.text)+'</p>':'')+'<label>'+esc(o.label)+'<input id="atInput" type="'+(o.type||"text")+'"'+(o.min!=null?' min="'+o.min+'"':'')+(o.max!=null?' max="'+o.max+'"':'')+' maxlength="100" value="'+esc(o.value||"")+'" placeholder="'+esc(o.placeholder||"")+'"></label><div class="toolbar"><button type="button" class="primary" id="atOk">'+esc(o.confirmText||"Continue")+'</button><button type="button" class="secondary" id="atCancel">Cancel</button></div><div class="status" id="atErr" role="alert"></div></div>';
      document.body.appendChild(ov);
      const inp=ov.querySelector("#atInput");inp.focus();inp.select();
      const close=v=>{ov.remove();resolve(v);};
      const ok=()=>{const v=inp.value.trim();const m=o.validate?o.validate(v):"";if(m){ov.querySelector("#atErr").textContent=m;return;}close(v);};
      ov.querySelector("#atCancel").onclick=()=>close(null);
      ov.querySelector("#atOk").onclick=ok;
      inp.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();ok();}else if(e.key==="Escape")close(null);});
      ov.addEventListener("click",e=>{if(e.target===ov)close(null);});
    });
  }
  async function publishTournament(id){
    if(!state.tnAdmin)return;
    const {error}=await client.from("tournament_tournaments").update({status:"registration_open",updated_at:new Date().toISOString()}).eq("id",id).eq("status","draft");
    if(error){status("tournamentStatus",error.message,"error");return;}
    toast("Registration opened.");await loadTournaments();
  }
  const fmtDeadline=d=>new Date(d).toLocaleString([],{dateStyle:"medium",timeStyle:"short"});
  const toLocalInput=d=>new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
  // Date/time picker dialog. Resolves to an ISO string, "" (no deadline) or null (cancelled).
  function askDeadline(opts){
    return new Promise(resolve=>{
      const ov=document.createElement("div");ov.className="modal-overlay";
      ov.innerHTML='<div class="modal-box" role="dialog" aria-modal="true"><h3>'+esc(opts.title)+'</h3><p class="small">'+esc(opts.text||"")+'</p>'
        +'<label>Deadline<input type="datetime-local" id="dlInput" value="'+esc(opts.defaultValue||toLocalInput(new Date(Date.now()+7*864e5)))+'"></label>'
        +(opts.allowNone?'<label class="check-row"><input type="checkbox" id="dlNone"> No deadline</label>':'')
        +'<div class="toolbar"><button type="button" class="primary" id="dlOk">'+esc(opts.confirmText||"Save")+'</button><button type="button" class="secondary" id="dlCancel">Cancel</button></div><div class="status" id="dlErr"></div></div>';
      document.body.appendChild(ov);
      const close=v=>{ov.remove();resolve(v);};
      ov.querySelector("#dlCancel").onclick=()=>close(null);
      ov.addEventListener("click",e=>{if(e.target===ov)close(null);});
      ov.querySelector("#dlOk").onclick=()=>{
        if(ov.querySelector("#dlNone")?.checked)return close("");
        const v=ov.querySelector("#dlInput").value,d=new Date(v);
        if(!v||isNaN(d)){ov.querySelector("#dlErr").textContent="Choose a date and time"+(opts.allowNone?", or tick No deadline.":".");return;}
        if(d<=new Date()){ov.querySelector("#dlErr").textContent="The deadline must be in the future.";return;}
        close(d.toISOString());
      };
    });
  }
  // ---- Tournament presentation helpers ----
  var tnFilter="live",tnOpen=null,tnRows=[],tnCounts={},tnShowHidden=false;
  const TN_ENDED=["completed","archived","cancelled"];
  const TN_STATE={draft:["Draft",""],registration_open:["Registration open","open"],registration_closed:["Registration closed",""],in_progress:["Live","live"],paused:["Paused",""],completed:["Finished","done"],archived:["Archived","done"],cancelled:["Cancelled","done"]};
  const TN_FORMAT={round_robin:"Round robin",knockout:"Knockout",group_knockout:"Groups + knockout",swiss:"Swiss"};
  const TN_FLOW={participant_admin:"Players submit, admin approves",admin_entered:"Admin enters scores",participant_opponent_admin:"Players submit, opponent confirms, admin approves"};
  const TN_MATCH={pending_result:"Awaiting admin approval",pending_confirmation:"Awaiting opponent confirmation",disputed:"Under admin review",postponed:"Postponed",cancelled:"Cancelled"};
  function tnCategory(t){return t.status==="draft"?"drafts":t.status==="archived"?"archived":["completed","cancelled"].includes(t.status)?"finished":"live";}
  function tnStateHtml(st){const x=TN_STATE[st]||[String(st).replaceAll("_"," "),""];return '<span class="tn-state '+x[1]+'">'+esc(x[0])+'</span>';}
  // ---- Profile pictures: tiny JPEGs in the public "avatars" bucket, looked up by id, user id or name ----
  function paintDbAvatar(){
    const el=$("dbAvatar");if(!el)return;
    const name=state.player?.display_name||"";
    el.textContent=initials(name||"?");
    const u=avUrl({uid:state.session?.user?.id,name});
    el.style.backgroundImage=u?"url('"+u+"')":"";
    el.toggleAttribute("data-av",!!u);
    const rm=$("dbPhotoRemove");if(rm)rm.hidden=!u;
  }
  // Shrink to a 192px square JPEG (about 8-15 KB) before upload so storage stays tiny.
  function shrinkImage(file){
    return new Promise((resolve,reject)=>{
      const img=new Image(),url=URL.createObjectURL(file);
      img.onload=()=>{
        URL.revokeObjectURL(url);
        const side=Math.min(img.width,img.height),size=192,c=document.createElement("canvas");
        c.width=c.height=size;
        c.getContext("2d").drawImage(img,(img.width-side)/2,(img.height-side)/2,side,side,0,0,size,size);
        c.toBlob(b=>b?resolve(b):reject(new Error("Could not process this image.")),"image/jpeg",0.78);
      };
      img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error("That file is not a readable image."));};
      img.src=url;
    });
  }
  async function changePhoto(file){
    if(!file||!state.session||!state.player)return;
    const msg=$("dbPhotoMsg");msg.textContent="Uploading…";
    try{
      if(!/^image\//.test(file.type))throw new Error("Choose an image file.");
      const blob=await shrinkImage(file);
      const path=state.session.user.id+"/avatar.jpg";
      const up=await client.storage.from("avatars").upload(path,blob,{upsert:true,contentType:"image/jpeg",cacheControl:"3600"});
      if(up.error)throw up.error;
      const r=await client.rpc("set_my_avatar",{p_set:true});if(r.error)throw r.error;
      await ensureAvatars(true);paintDbAvatar();msg.textContent="Photo updated.";toast("Profile photo updated.");
    }catch(e){msg.textContent=e.message||"Could not upload the photo.";}
  }
  async function removePhoto(){
    if(!state.session)return;const msg=$("dbPhotoMsg");msg.textContent="Removing…";
    try{
      await client.storage.from("avatars").remove([state.session.user.id+"/avatar.jpg"]);
      const r=await client.rpc("set_my_avatar",{p_set:false});if(r.error)throw r.error;
      await ensureAvatars(true);paintDbAvatar();msg.textContent="Photo removed.";
    }catch(e){msg.textContent=e.message||"Could not remove the photo.";}
  }
  var avMap={id:{},uid:{},name:{}},avP=null;
  function avKey(n){return String(n||"").trim().replace(/\s+/g," ").toLowerCase();}
  function ensureAvatars(force){
    if(!client)return Promise.resolve();
    if(avP&&!force)return avP;
    avP=(async()=>{try{
      const {data}=await client.from("player_avatars").select("id,user_id,display_name,avatar_updated_at");
      const m={id:{},uid:{},name:{}};
      // Only use pictures that actually load, so a broken link falls back to initials.
      await Promise.all((data||[]).map(r=>new Promise(res=>{
        const u=client.storage.from("avatars").getPublicUrl(r.user_id+"/avatar.jpg").data.publicUrl+"?v="+encodeURIComponent(r.avatar_updated_at);
        const im=new Image();
        const done=ok=>{if(ok){m.id[r.id]=u;m.uid[r.user_id]=u;m.name[avKey(r.display_name)]=u;}res();};
        im.onload=()=>done(true);im.onerror=()=>done(false);setTimeout(()=>done(false),6000);im.src=u;
      })));
      avMap=m;
    }catch(e){console.warn("Avatars unavailable",e);}})();
    return avP;
  }
  function avUrl(o){o=o||{};return (o.id&&avMap.id[o.id])||(o.uid&&avMap.uid[o.uid])||avMap.name[avKey(o.name)]||"";}
  function av(name,o){const u=avUrl(Object.assign({name},o));return u?' data-av="1" style="background-image:url(\''+esc(u)+'\')"':'';}

  // ================= Head to Head + club legends =================
  var h2hReady=false;
  function nameOf(p){return p?p.display_name:"";}
  function avBig(name,id,cls){return '<span class="'+cls+'" aria-hidden="true"'+av(name,{id:id})+'>'+esc(initials(name))+'</span>';}
  async function loadH2hPage(){
    if(!client)return;
    $("legendsMonth").value=$("legendsMonth").value||monthNow;
    await ensureAvatars();
    if(!h2hReady){
      const {data}=await client.from("active_player_directory").select("id,display_name").order("display_name");
      state.h2hPlayers=data||[];
      const opts='<option value="">Choose player</option>'+state.h2hPlayers.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.display_name)+'</option>').join("");
      $("h2hA").innerHTML=opts;$("h2hB").innerHTML=opts;
      if(state.player&&state.player.active)$("h2hA").value=state.player.id;
      h2hReady=true;
    }
    renderH2h();loadLegends();
  }
  async function renderH2h(){
    const a=$("h2hA").value,b=$("h2hB").value,box=$("h2hResult");
    const P=id=>(state.h2hPlayers||[]).find(p=>p.id===id);
    if(!a||!b||a===b){
      box.innerHTML='<div class="h2h-empty"><b>'+(a&&a===b?"Pick two different players.":"Choose two players to start the rivalry.")+'</b><span>Every counted result between them shows up here.</span></div>';return;
    }
    box.innerHTML='<div class="h2h-empty"><span>Loading the rivalry…</span></div>';
    const {data,error}=await client.rpc("get_head_to_head",{p_a:a,p_b:b});
    if(error){box.innerHTML='<div class="h2h-empty"><b>Could not load this rivalry.</b><span>'+esc(error.message)+'</span></div>';return;}
    const A=nameOf(P(a)),B=nameOf(P(b)),ms=data||[];
    const n=ms.length;
    const t={w:[0,0],gf:[0,0],cs:[0,0],big:[0,0],d:0,streak:[0,0]};
    let run=[0,0];
    // oldest first for streaks; ms arrives newest first
    [...ms].reverse().forEach(m=>{
      t.gf[0]+=m.a_goals;t.gf[1]+=m.b_goals;
      if(m.b_goals===0)t.cs[0]++;if(m.a_goals===0)t.cs[1]++;
      if(m.a_goals>m.b_goals){t.w[0]++;run[0]++;run[1]=0;t.big[0]=Math.max(t.big[0],m.a_goals-m.b_goals);}
      else if(m.a_goals<m.b_goals){t.w[1]++;run[1]++;run[0]=0;t.big[1]=Math.max(t.big[1],m.b_goals-m.a_goals);}
      else{t.d++;run=[0,0];}
      t.streak[0]=Math.max(t.streak[0],run[0]);t.streak[1]=Math.max(t.streak[1],run[1]);
    });
    const pct=v=>n?Math.round(v/n*100):0;
    const share=[pct(t.w[0]),pct(t.d),pct(t.w[1])];
    // keep the three segments adding to 100
    share[1]=Math.max(0,100-share[0]-share[2]);
    const lead=t.w[0]===t.w[1]?-1:(t.w[0]>t.w[1]?0:1);
    const names=[A,B];
    let verdict;
    if(!n)verdict={t:"No clashes on record",s:"Somebody has to start this rivalry. Play it, submit it, settle it."};
    else if(lead===-1)verdict=t.d>=Math.max(t.w[0],t.w[1])?{t:"The draw merchants",s:"Nobody can separate them. "+t.d+" draw"+(t.d===1?"":"s")+" in "+n+" meetings."}:{t:"Dead level",s:t.w[0]+" wins each. The next meeting decides who gets bragging rights."};
    else{
      const W=names[lead],L=names[1-lead],w=t.w[lead],l=t.w[1-lead];
      if(n>=3&&l===0)verdict={t:W+" owns "+L,s:"Unbeaten in "+n+" meetings. "+L+" is still waiting for a first win."};
      else if(w>=2*l&&n>=3)verdict={t:W+" is in "+L+"'s head",s:w+" wins to "+l+". "+L+" needs a miracle, or at least a plan."};
      else verdict={t:W+" holds the edge",s:w+"–"+l+" in wins. "+L+" will want revenge."};
    }
    const last=ms[0];
    const lastTxt=last?'Last meeting: '+esc(A)+' '+last.a_goals+'–'+last.b_goals+' '+esc(B)+' · '+prettyDate(last.match_date):'';
    const row=(label,x,y,fmt)=>{
      const f=fmt||(v=>v),tot=(Number(x)+Number(y))||1;
      const xw=x>y?"lead":"",yw=y>x?"lead":"";
      return '<div class="h2h-row"><b class="'+xw+'">'+esc(f(x))+'</b><div class="h2h-meter"><i style="width:'+Math.round(Number(x)/tot*100)+'%"></i><u style="width:'+Math.round(Number(y)/tot*100)+'%"></u><span>'+esc(label)+'</span></div><b class="'+yw+'">'+esc(f(y))+'</b></div>';
    };
    const avg=g=>n?(g/n).toFixed(2):"0.00";
    const form=side=>ms.slice(0,5).map(m=>{
      const x=side?m.b_goals:m.a_goals,y=side?m.a_goals:m.b_goals;
      return '<i class="fm '+(x>y?'w':x<y?'l':'d')+'">'+(x>y?'W':x<y?'L':'D')+'</i>';
    }).join("")||'<em>—</em>';
    box.innerHTML=
      '<div class="h2h-arena">'+
        '<div class="h2h-side h2h-left link-player'+(lead===0?' is-lead':'')+'" data-player="'+esc(a)+'">'+avBig(A,a,"h2h-av")+'<b class="h2h-name">'+esc(A)+'</b><span class="h2h-wins">'+t.w[0]+'<small>wins</small></span><span class="h2h-form">'+form(0)+'</span></div>'+
        '<div class="h2h-mid"><span class="h2h-vs">VS</span><span class="h2h-played">'+n+' meeting'+(n===1?'':'s')+'</span></div>'+
        '<div class="h2h-side h2h-right link-player'+(lead===1?' is-lead':'')+'" data-player="'+esc(b)+'">'+avBig(B,b,"h2h-av")+'<b class="h2h-name">'+esc(B)+'</b><span class="h2h-wins">'+t.w[1]+'<small>wins</small></span><span class="h2h-form">'+form(1)+'</span></div>'+
      '</div>'+
      (n?'<div class="h2h-share" role="img" aria-label="Win share"><i class="s-a" style="width:'+share[0]+'%"></i><i class="s-d" style="width:'+share[1]+'%"></i><i class="s-b" style="width:'+share[2]+'%"></i></div>'+
         '<div class="h2h-share-key"><span>'+esc(A)+' '+share[0]+'%</span><span>Draws '+share[1]+'%</span><span>'+esc(B)+' '+share[2]+'%</span></div>':'')+
      '<div class="h2h-verdict"><b>'+esc(verdict.t)+'</b><span>'+esc(verdict.s)+'</span>'+(lastTxt?'<small>'+lastTxt+'</small>':'')+'</div>'+
      (n?'<div class="h2h-stats">'+
        row("Wins",t.w[0],t.w[1])+row("Goals scored",t.gf[0],t.gf[1])+row("Goals per match",avg(t.gf[0]),avg(t.gf[1]),v=>v)+
        row("Clean sheets",t.cs[0],t.cs[1])+row("Biggest win (margin)",t.big[0],t.big[1],v=>v?"+"+v:"—")+row("Best winning run",t.streak[0],t.streak[1])+
      '</div>'+
      '<h3 class="h2h-hist-title">Match history</h3><div class="h2h-hist">'+ms.map(m=>{
        const r=m.a_goals>m.b_goals?"a":m.a_goals<m.b_goals?"b":"d";
        return '<div class="h2h-m r-'+r+'"><span class="d">'+prettyDate(m.match_date)+'</span><span class="n l'+(r==="a"?' win':'')+'">'+esc(A)+'</span><span class="sc">'+m.a_goals+' – '+m.b_goals+'</span><span class="n r'+(r==="b"?' win':'')+'">'+esc(B)+'</span></div>';
      }).join("")+'</div>':'');
    box.insertAdjacentHTML("beforeend",'<section id="h2hTrash" class="tt-wrap"></section>');
    renderTrash(a,b);
  }
  $("h2hA").addEventListener("change",renderH2h);
  $("h2hB").addEventListener("change",renderH2h);
  $("h2hSwap").addEventListener("click",()=>{const x=$("h2hA").value;$("h2hA").value=$("h2hB").value;$("h2hB").value=x;renderH2h();});
  $("legendsMonth").addEventListener("change",loadLegends);



  // ---- date + rank-movement helpers ----
  function addDays(d,n){const x=new Date(d);x.setDate(x.getDate()+n);return x;}
  function ymd(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");}
  // rank now vs rank a week ago; null map when there is nothing to compare against
  function rankMoves(now,prev){
    const m={};
    if(!now||!prev||!prev.some(r=>Number(r.matches_played)>0))return m;
    const pm={};prev.forEach(r=>pm[r.player_id]=r);
    now.forEach(r=>{
      const p=pm[r.player_id];
      if(!p||Number(p.matches_played)===0){m[r.player_id]=Number(r.matches_played)>0?{isNew:true}:null;return;}
      m[r.player_id]={d:Number(p.rank)-Number(r.rank)};
    });
    return m;
  }
  function moveHtml(x){
    if(!x)return "";
    if(x.isNew)return '<i class="mv new" title="New in the table this week">NEW</i>';
    if(x.d>0)return '<i class="mv up" title="Up '+x.d+' since last week">▲'+x.d+'</i>';
    if(x.d<0)return '<i class="mv down" title="Down '+(-x.d)+' since last week">▼'+(-x.d)+'</i>';
    return '<i class="mv same" title="No change since last week">–</i>';
  }
  function timeAgo(iso){
    const s=Math.max(1,Math.round((Date.now()-new Date(iso).getTime())/1000));
    if(s<60)return "just now";if(s<3600)return Math.floor(s/60)+"m ago";if(s<86400)return Math.floor(s/3600)+"h ago";
    if(s<604800)return Math.floor(s/86400)+"d ago";return prettyDate(String(iso).slice(0,10));
  }

  // ================= Trash talk wall (inside Head to Head) =================
  async function renderTrash(a,b){
    const box=$("h2hTrash");if(!box)return;
    const {data,error}=await client.rpc("get_trash_talk",{p_a:a,p_b:b});
    if(error){box.innerHTML='<p class="tt-sub">Could not load the wall.</p>';return;}
    const names={};(state.h2hPlayers||[]).forEach(p=>names[p.id]=p.display_name);
    const canPost=!!state.session&&state.player&&state.player.active;
    const compose=canPost?'<form class="tt-compose" id="ttForm"><textarea id="ttText" maxlength="200" rows="2" placeholder="Say something to '+esc(names[a]||"them")+' or '+esc(names[b]||"them")+'. Keep it playful."></textarea><div class="tt-bar"><span id="ttCount">0 / 200</span><button class="primary" type="submit" id="ttPost">Post</button></div><div id="ttMsg" class="status"></div></form>'
      :'<p class="tt-signin">'+(state.session?'Only active registered players can post.':'Sign in to join the banter.')+'</p>';
    const list=(data||[]).map(t=>{
      const side=t.author_player_id===a?"l":t.author_player_id===b?"r":"f";
      return '<div class="tt-msg '+side+'">'+avBig(t.author_name,t.author_player_id,"tt-av")+'<div class="tt-bub"><div class="tt-meta"><b class="link-player" data-player="'+esc(t.author_player_id)+'">'+esc(t.author_name)+'</b>'+(side==="f"?'<em>fan</em>':'')+'<span>'+timeAgo(t.created_at)+'</span>'+(t.can_hide?'<button type="button" class="tt-x" data-tt="'+esc(t.id)+'" title="Remove this post">Remove</button>':'')+'</div><p>'+esc(t.body)+'</p></div></div>';
    }).join("")||'<p class="tt-empty">Quiet so far. Start the banter.</p>';
    box.innerHTML='<h3 class="h2h-hist-title">Trash talk</h3><p class="tt-sub">Friendly banter only. Abuse gets removed.</p>'+compose+'<div class="tt-list">'+list+'</div>';
    const f=$("ttForm");
    if(f){
      const ta=$("ttText");
      ta.addEventListener("input",()=>{$("ttCount").textContent=ta.value.length+" / 200";});
      f.addEventListener("submit",async e=>{
        e.preventDefault();const body=ta.value.trim();if(!body)return;
        $("ttPost").disabled=true;
        const r=await client.rpc("post_trash_talk",{p_a:a,p_b:b,p_body:body});
        if(r.error){status("ttMsg",r.error.message,"error");$("ttPost").disabled=false;return;}
        renderTrash(a,b);
      });
    }
    box.querySelectorAll("[data-tt]").forEach(btn=>btn.addEventListener("click",async()=>{
      if(!confirm("Remove this post?"))return;
      const r=await client.rpc("hide_trash_talk",{p_id:btn.dataset.tt});
      if(r.error){toast(r.error.message);return;}
      renderTrash(a,b);
    }));
  }

  // ================= BPC Weekly newsletter =================
  var weeklyStart=null;
  function mondayOf(d){const x=new Date(d.getFullYear(),d.getMonth(),d.getDate());const k=(x.getDay()+6)%7;x.setDate(x.getDate()-k);return x;}
  function fmtRange(a,b){
    const o={day:"numeric",month:"short"};
    return a.toLocaleDateString(undefined,o)+" – "+b.toLocaleDateString(undefined,{...o,year:"numeric"});
  }
  async function fetchWeek(start){
    const end=addDays(start,6);
    const r=await client.rpc("get_week_matches",{p_start:ymd(start),p_end:ymd(end)});
    return r.error?null:(r.data||[]).map(m=>({...m,a_goals:Number(m.a_goals),b_goals:Number(m.b_goals)}));
  }
  async function loadWeekly(){
    const box=$("weeklyPage");if(!client||!box)return;
    box.innerHTML='<div class="h2h-empty"><span>Loading this week…</span></div>';
    await ensureAvatars();
    let rows=null;
    if(!weeklyStart){
      // open on the latest week that has results (looking back up to 8 weeks)
      let s=mondayOf(new Date());
      for(let i=0;i<8;i++){rows=await fetchWeek(s);if(rows&&rows.length){break;}if(i<7)s=addDays(s,-7);}
      weeklyStart=s;
    }else rows=await fetchWeek(weeklyStart);
    renderWeekly(rows||[]);
  }
  async function renderWeekly(rows){
    const box=$("weeklyPage"),start=weeklyStart,end=addDays(start,6);
    const thisWeek=ymd(start)===ymd(mondayOf(new Date()));
    // per-player perspectives (registered players only)
    const P={};
    const add=(id,name,gf,ga)=>{if(!id)return;const o=P[id]=P[id]||{id,name,n:0,w:0,d:0,l:0,gf:0,ga:0,cs:0,pts:0};o.n++;o.gf+=gf;o.ga+=ga;if(ga===0)o.cs++;if(gf>ga){o.w++;o.pts+=3;}else if(gf===ga){o.d++;o.pts+=1;}else o.l++;};
    rows.forEach(m=>{add(m.a_id,m.a_name,m.a_goals,m.b_goals);add(m.b_id,m.b_name,m.b_goals,m.a_goals);});
    const pl=Object.values(P);
    const goals=rows.reduce((s,m)=>s+m.a_goals+m.b_goals,0);
    const best=(arr,fn)=>arr.length?[...arr].sort(fn)[0]:null;
    const potw=best(pl.filter(p=>p.n>=2),(x,y)=>y.pts-x.pts||(y.gf-y.ga)-(x.gf-x.ga)||y.gf-x.gf||x.name.localeCompare(y.name));
    const scorer=best(pl.filter(p=>p.gf>0),(x,y)=>y.gf-x.gf||x.n-y.n||x.name.localeCompare(y.name));
    const wall=best(pl.filter(p=>p.cs>0),(x,y)=>y.cs-x.cs||x.n-y.n||x.name.localeCompare(y.name));
    const busy=best(pl,(x,y)=>y.n-x.n||y.pts-x.pts||x.name.localeCompare(y.name));
    const bigWin=best(rows.filter(m=>m.a_goals!==m.b_goals),(x,y)=>Math.abs(y.a_goals-y.b_goals)-Math.abs(x.a_goals-x.b_goals)||(y.a_goals+y.b_goals)-(x.a_goals+x.b_goals));
    const thriller=best(rows,(x,y)=>(y.a_goals+y.b_goals)-(x.a_goals+x.b_goals)||Math.abs(x.a_goals-x.b_goals)-Math.abs(y.a_goals-y.b_goals));
    // rivalry of the week: registered pair that met most often
    const pairs={};
    rows.forEach(m=>{if(!m.a_id||!m.b_id)return;const k=[m.a_id,m.b_id].sort().join("|");const o=pairs[k]=pairs[k]||{a:m.a_id,an:m.a_name,b:m.b_id,bn:m.b_name,n:0,aw:0,bw:0,d:0};o.n++;
      const ag=m.a_id===o.a?m.a_goals:m.b_goals,bg=m.a_id===o.a?m.b_goals:m.a_goals;if(ag>bg)o.aw++;else if(ag<bg)o.bw++;else o.d++;});
    const rival=best(Object.values(pairs).filter(p=>p.n>=2),(x,y)=>y.n-x.n||x.an.localeCompare(y.an));
    // standings at the end of the week, with movement vs the week before
    const cutoff=end>new Date()?new Date():end;
    const monthStr=ymd(cutoff).slice(0,7);
    const prevCut=addDays(cutoff,-7);
    const [nowR,prevR]=await Promise.all([
      client.rpc("get_leaderboard_asof",{p_month:monthStr+"-01",p_cutoff:ymd(cutoff)}),
      ymd(prevCut).slice(0,7)===monthStr?client.rpc("get_leaderboard_asof",{p_month:monthStr+"-01",p_cutoff:ymd(prevCut)}):Promise.resolve({data:null})
    ]);
    const table=(nowR.data||[]).filter(r=>Number(r.matches_played)>0).slice(0,5);
    const mv=rankMoves(nowR.data,prevR.data);
    const nm=(id,n)=>avBig(n,id,"wk-av");
    const award=(label,p,val,unit)=>p?'<div class="wk-award link-player" data-player="'+esc(p.id)+'">'+nm(p.id,p.name)+'<div><small>'+label+'</small><b>'+esc(p.name)+'</b><span>'+val+' '+unit+'</span></div></div>':'';
    const matchCard=(label,m)=>m?'<div class="wk-match"><small>'+label+'</small><div class="wk-score"><span class="'+(m.a_goals>m.b_goals?'win':'')+'">'+esc(m.a_name)+'</span><b>'+m.a_goals+' – '+m.b_goals+'</b><span class="'+(m.b_goals>m.a_goals?'win':'')+'">'+esc(m.b_name)+'</span></div><em>'+prettyDate(m.match_date)+'</em></div>':'';
    const headline=!rows.length?"A quiet week on the pitch":
      (potw?esc(potw.name)+" had the week: "+potw.w+" win"+(potw.w===1?"":"s")+" from "+potw.n+" played.":rows.length+" matches played this week.");
    const awards=[award("Player of the week",potw,potw?potw.pts:0,"pts"),award("Top scorer",scorer,scorer?scorer.gf:0,"goals"),award("Clean sheet king",wall,wall?wall.cs:0,"clean sheets"),award("Busiest player",busy,busy?busy.n:0,"matches")].join("");
    box.innerHTML=
      '<div class="wk-mast"><div><h2>BPC Weekly</h2><p>'+fmtRange(start,end)+'</p></div><div class="wk-nav"><button type="button" id="wkPrev" aria-label="Previous week">←</button><button type="button" id="wkNext" aria-label="Next week"'+(thisWeek?' disabled':'')+'>→</button></div></div>'+
      '<p class="wk-headline">'+headline+'</p>'+
      (rows.length?
      '<div class="wk-nums"><div><b>'+rows.length+'</b><span>Matches</span></div><div><b>'+goals+'</b><span>Goals</span></div><div><b>'+(goals/rows.length).toFixed(1)+'</b><span>Goals per match</span></div><div><b>'+pl.length+'</b><span>Players in action</span></div></div>'+
      '<div class="wk-grid">'+
        '<section class="pf-card"><h3>Awards of the week</h3><div class="wk-awards">'+awards+'</div></section>'+
        '<section class="pf-card"><h3>Table after the week <small>'+new Date(monthStr+"-01T12:00:00").toLocaleDateString(undefined,{month:"long"})+'</small></h3>'+
          '<ol class="wk-table">'+table.map(r=>'<li class="link-player" data-player="'+esc(r.player_id)+'"><span class="n">'+r.rank+'</span>'+nm(r.player_id,r.player_name)+'<span class="nm">'+esc(r.player_name)+'</span>'+moveHtml(mv[r.player_id])+'<b>'+r.points+'</b></li>').join("")+'</ol>'+
          '<p class="pf-note">Arrows compare with a week earlier.</p></section>'+
      '</div>'+
      '<section class="pf-card pf-wide"><h3>Match of the week</h3><div class="wk-matches">'+matchCard("Biggest win",bigWin)+matchCard("Highest scoring",thriller)+'</div>'+
        (rival?'<div class="wk-rival link-player" data-player="'+esc(rival.a)+'"><small>Rivalry of the week</small><b>'+esc(rival.an)+' vs '+esc(rival.bn)+'</b><span>'+rival.n+' meetings · '+rival.aw+'W '+rival.d+'D '+rival.bw+'L for '+esc(rival.an)+'</span></div>':'')+'</section>'
      :'<div class="h2h-empty"><b>No counted matches this week.</b><span>Use the arrows to browse other weeks.</span></div>');
    $("wkPrev").addEventListener("click",async()=>{weeklyStart=addDays(weeklyStart,-7);box.innerHTML='<div class="h2h-empty"><span>Loading…</span></div>';renderWeekly(await fetchWeek(weeklyStart)||[]);});
    const nx=$("wkNext");if(nx)nx.addEventListener("click",async()=>{weeklyStart=addDays(weeklyStart,7);box.innerHTML='<div class="h2h-empty"><span>Loading…</span></div>';renderWeekly(await fetchWeek(weeklyStart)||[]);});
  }

  // ================= Public player profile =================
  var pfScope={mode:"all",month:monthNow},pfCache={};
  function openPlayer(id){if(!id)return;state.viewPlayerId=id;pfScope={mode:"all",month:monthNow};showView("player");}
  document.addEventListener("click",e=>{
    const t=e.target.closest("[data-player]");
    if(t&&t.dataset.player){e.preventDefault();openPlayer(t.dataset.player);}
  });
  $("pfBack").addEventListener("click",()=>showView(state.pfFrom||"leaderboard"));
  $("dbPublicProfile").addEventListener("click",()=>{if(state.player)openPlayer(state.player.id);});
  function pfStats(rows){
    const o={n:rows.length,w:0,d:0,l:0,gf:0,ga:0,cs:0};
    rows.forEach(r=>{o.gf+=r.gf;o.ga+=r.ga;if(r.ga===0)o.cs++;if(r.gf>r.ga)o.w++;else if(r.gf<r.ga)o.l++;else o.d++;});
    o.pts=o.w*3+o.d;o.rate=o.n?Math.round(o.w/o.n*100):0;return o;
  }
  const pfRes=r=>r.gf>r.ga?"w":r.gf<r.ga?"l":"d";
  function pfBadges(all){
    const asc=[...all].reverse();
    let bestW=0,bestU=0,w=0,u=0;
    asc.forEach(r=>{const x=pfRes(r);w=x==="w"?w+1:0;u=x!=="l"?u+1:0;bestW=Math.max(bestW,w);bestU=Math.max(bestU,u);});
    const byMonth={};all.forEach(r=>{const k=r.match_date.slice(0,7);byMonth[k]=(byMonth[k]||0)+1;});
    const maxMonth=Math.max(0,...Object.values(byMonth));
    const opps=new Set(all.map(r=>(r.opponent_id||r.opponent_name))).size;
    const st=pfStats(all);
    const defs=[
      ["⚽","Hat-trick hero","Score 3+ goals in a match",Math.max(0,...all.map(r=>r.gf)),3],
      ["💥","Goal machine","Score 5+ goals in a match",Math.max(0,...all.map(r=>r.gf)),5],
      ["🧤","Brick wall","Keep 5 clean sheets",st.cs,5],
      ["🔥","On fire","Win 5 matches in a row",bestW,5],
      ["🛡️","Unbeaten","Go 8 matches without a loss",bestU,8],
      ["🤝","Social player","Play 10 different opponents",opps,10],
      ["📅","Busy month","Play 40 matches in a month",maxMonth,40],
      ["💯","Century club","Play 100 matches",st.n,100]
    ];
    return {defs,bestW,bestU};
  }
  async function renderPlayerPage(){
    const box=$("playerPage"),id=state.viewPlayerId;
    if(!client||!id){box.innerHTML="";return;}
    box.innerHTML='<div class="h2h-empty"><span>Loading profile…</span></div>';
    const lbMonth=monthDate(pfScope.mode==="month"?pfScope.month:monthNow);
    const [mres,dir,lb]=await Promise.all([client.rpc("get_player_matches",{p_player:id}),client.from("active_player_directory").select("id,display_name").eq("id",id).maybeSingle(),client.rpc("get_leaderboard",{p_month:monthDate(monthNow)}),ensureAvatars()]);
    const me=dir.data;
    if(!me||mres.error){box.innerHTML='<div class="h2h-empty"><b>Player not found.</b><span>This profile is not available.</span></div>';return;}
    const all=(mres.data||[]).map(r=>({...r,gf:Number(r.gf),ga:Number(r.ga)}));
    const rows=pfScope.mode==="month"?all.filter(r=>r.match_date.slice(0,7)===pfScope.month):all;
    const st=pfStats(rows);
    const lbRow=(lb.data||[]).find(r=>r.player_id===id);
    const monthLabel=d=>new Date(d+"-01T12:00:00").toLocaleDateString(undefined,{month:"short",year:"numeric"});
    // form + streak (always all-time)
    const form=all.slice(0,10),f0=form.map(pfRes);
    let streak=0,kind=f0[0];for(const x of f0){if(x===kind)streak++;else break;}
    let unb=0;for(const x of f0){if(x!=="l")unb++;else break;}
    const streakTxt=!all.length?"":kind==="w"&&streak>=2?"On a "+streak+"-match winning run":unb>=3?"Unbeaten in "+unb:kind==="l"&&streak>=2?"Lost the last "+streak:"";
    // rivalries within scope
    const opp={};
    rows.forEach(r=>{const k=r.opponent_id||("n:"+r.opponent_name);(opp[k]=opp[k]||{id:r.opponent_id,name:r.opponent_name,rows:[]}).rows.push(r);});
    const oppList=Object.values(opp).map(o=>({...o,s:pfStats(o.rows)}));
    const most=[...oppList].sort((a,b)=>b.s.n-a.s.n||a.name.localeCompare(b.name))[0];
    const eligible=oppList.filter(o=>o.s.n>=3);
    const nemesis=[...eligible].filter(o=>o.s.rate<50).sort((a,b)=>a.s.rate-b.s.rate||b.s.n-a.s.n)[0];
    const victim=[...eligible].filter(o=>o.s.rate>50).sort((a,b)=>b.s.rate-a.s.rate||b.s.n-a.s.n)[0];
    const rivalCard=(label,o,note)=>o?'<div class="pf-riv'+(o.id?' link-player':'')+'"'+(o.id?' data-player="'+esc(o.id)+'"':'')+'>'+avBig(o.name,o.id,"pf-mini")+'<div><small>'+label+'</small><b>'+esc(o.name)+'</b><span>'+o.s.w+'W '+o.s.d+'D '+o.s.l+'L · '+o.s.n+' played</span></div></div>':'<div class="pf-riv is-empty"><div><small>'+label+'</small><span>'+note+'</span></div></div>';
    // highlights
    const bigWin=[...rows].filter(r=>r.gf>r.ga).sort((a,b)=>(b.gf-b.ga)-(a.gf-a.ga)||b.gf-a.gf)[0];
    const topScore=[...rows].sort((a,b)=>(b.gf+b.ga)-(a.gf+a.ga))[0];
    const hl=(label,r,txt)=>r?'<div class="pf-hl"><small>'+label+'</small><b>'+txt+'</b><span>vs '+esc(r.opponent_name)+' · '+prettyDate(r.match_date)+'</span></div>':'<div class="pf-hl"><small>'+label+'</small><span>Nothing yet</span></div>';
    // monthly points (last 12 months, all-time data)
    const months=[];const base=new Date();base.setDate(1);
    for(let i=11;i>=0;i--){const d=new Date(base.getFullYear(),base.getMonth()-i,1);months.push(d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0"));}
    const pts=months.map(k=>{const s=pfStats(all.filter(r=>r.match_date.slice(0,7)===k));return {k,p:s.pts,n:s.n};});
    const maxP=Math.max(1,...pts.map(x=>x.p));
    const bestM=[...pts].sort((a,b)=>b.p-a.p)[0];
    const chart='<div class="pf-bars" role="img" aria-label="Points per month">'+pts.map(x=>'<div class="pf-bar'+(x.k===(bestM&&bestM.p?bestM.k:"")?' is-best':'')+'" title="'+monthLabel(x.k)+': '+x.p+' pts"><i style="height:'+Math.max(x.p?6:2,Math.round(x.p/maxP*100))+'%"></i><span>'+monthLabel(x.k).slice(0,3)+'</span></div>').join("")+'</div>';
    const bd=pfBadges(all);
    const badges=bd.defs.map(d=>{const ok=d[3]>=d[4];return '<div class="pf-badge'+(ok?' is-on':'')+'" title="'+esc(d[2])+'"><span class="g">'+d[0]+'</span><b>'+d[1]+'</b><small>'+(ok?"Earned":Math.min(d[3],d[4])+" / "+d[4])+'</small></div>';}).join("");
    const earned=bd.defs.filter(d=>d[3]>=d[4]).length;
    const recent=all.slice(0,8).map(r=>'<div class="pf-m r-'+pfRes(r)+'"><span class="d">'+prettyDate(r.match_date)+'</span><span class="o'+(r.opponent_id?' link-player':'')+'"'+(r.opponent_id?' data-player="'+esc(r.opponent_id)+'"':'')+'>'+esc(r.opponent_name)+'</span><span class="s">'+r.gf+' – '+r.ga+'</span></div>').join("")||'<div class="pf-none">No counted matches yet.</div>';
    const signed=!!state.session&&state.player&&state.player.id!==id;
    box.innerHTML=
      '<div class="pf-head">'+avBig(me.display_name,me.id,"pf-av")+
        '<div class="pf-id"><h2>'+esc(me.display_name)+'</h2><p>'+(lbRow?'Rank #'+lbRow.rank+' this month · '+lbRow.points+' pts':'Not ranked this month')+(streakTxt?' · '+esc(streakTxt):'')+'</p></div>'+
        '<div class="pf-actions"><button type="button" class="pf-btn" id="pfCompare">Compare'+(signed?' with me':'')+'</button></div></div>'+
      '<div class="pf-scope"><button type="button" class="'+(pfScope.mode==="all"?'on':'')+'" data-pfs="all">All time</button><button type="button" class="'+(pfScope.mode==="month"?'on':'')+'" data-pfs="month">Month</button>'+(pfScope.mode==="month"?'<input type="month" id="pfMonth" value="'+esc(pfScope.month)+'">':'')+'</div>'+
      '<div class="pf-tiles">'+
        [["Matches",st.n],["Win rate",st.rate+"%"],["W · D · L",st.w+" · "+st.d+" · "+st.l],["Goals",st.gf+" – "+st.ga],["Clean sheets",st.cs],["Points",st.pts]].map(t=>'<div class="pf-tile"><b>'+t[1]+'</b><span>'+t[0]+'</span></div>').join("")+'</div>'+
      '<div class="pf-grid">'+
        '<section class="pf-card"><h3>Recent form</h3><div class="pf-form">'+(form.map(r=>'<i class="fm '+pfRes(r)+'">'+pfRes(r).toUpperCase()+'</i>').join("")||'<em>No matches yet</em>')+'</div>'+
          '<h3>Points by month</h3>'+chart+(bestM&&bestM.p?'<p class="pf-note">Best month: '+monthLabel(bestM.k)+' with '+bestM.p+' points.</p>':'')+'</section>'+
        '<section class="pf-card"><h3>Rivalries</h3><div class="pf-rivs">'+rivalCard("Most played",most,"No matches yet")+rivalCard("Nemesis",nemesis,"Needs 3+ meetings")+rivalCard("Favourite opponent",victim,"Needs 3+ meetings")+'</div>'+
          '<h3>Highlights</h3><div class="pf-hls">'+hl("Biggest win",bigWin,bigWin?bigWin.gf+" – "+bigWin.ga:"")+hl("Highest scoring",topScore,topScore?topScore.gf+" – "+topScore.ga:"")+'</div></section>'+
      '</div>'+
      '<section class="pf-card pf-wide"><h3>Badges <small>'+earned+' of '+bd.defs.length+' earned</small></h3><div class="pf-badges">'+badges+'</div></section>'+
      '<section class="pf-card pf-wide"><h3>Latest matches</h3><div class="pf-ms">'+recent+'</div></section>';
    box.querySelectorAll("[data-pfs]").forEach(b=>b.addEventListener("click",()=>{pfScope.mode=b.dataset.pfs;renderPlayerPage();}));
    const pm=$("pfMonth");if(pm)pm.addEventListener("change",()=>{pfScope.month=pm.value||monthNow;renderPlayerPage();});
    $("pfCompare").addEventListener("click",async()=>{
      showView("h2h");await loadH2hPage();
      const mine=state.player&&state.player.active?state.player.id:"";
      if(mine&&mine!==id){$("h2hA").value=mine;$("h2hB").value=id;}else{$("h2hA").value=id;$("h2hB").value="";}
      renderH2h();
    });
  }
  setTimeout(loadHomeLegends,0);
  function legendCard(kind,scope,rows,monthLabel){
    const isG=kind==="goals";
    const key=isG?"goals_for":"clean_sheets";
    const list=[...(rows||[])].filter(r=>Number(r[key])>0).sort((x,y)=>Number(y[key])-Number(x[key])||Number(x.matches_played)-Number(y.matches_played)||String(x.player_name).localeCompare(y.player_name));
    const title=(isG?"Top scorer":"Top clean sheets")+' · '+(scope==="all"?"All time":monthLabel);
    if(!list.length)return '<article class="lg-card"><p class="lg-title">'+esc(title)+'</p><div class="lg-empty">No counted matches yet.</div></article>';
    const w=list[0];
    const sub=isG?(Number(w.matches_played)?(Number(w.goals_for)/Number(w.matches_played)).toFixed(2):"0.00")+' goals per match · '+w.matches_played+' matches'
                 :'in '+w.matches_played+' matches · '+Math.round(Number(w.clean_sheets)/Math.max(1,Number(w.matches_played))*100)+'% kept clean';
    const rest=list.slice(1,5).map((r,i)=>'<li class="link-player" data-player="'+esc(r.player_id)+'">'+avBig(r.player_name,r.player_id,"lg-mini")+'<span class="lg-rn">'+esc(r.player_name)+'</span><b>'+r[key]+'</b><em>'+(i+2)+'</em></li>').join("");
    return '<article class="lg-card"><p class="lg-title">'+esc(title)+'</p>'+
      '<div class="lg-top link-player" data-player="'+esc(w.player_id)+'"><div class="lg-crown">'+avBig(w.player_name,w.player_id,"lg-av")+'<span class="lg-badge">'+(isG?"⚽":"🧤")+'</span></div>'+
      '<div class="lg-who"><b class="lg-name">'+esc(w.player_name)+'</b><span class="lg-num">'+w[key]+'<small>'+(isG?" goals":" clean sheets")+'</small></span><span class="lg-sub">'+esc(sub)+'</span></div></div>'+
      (rest?'<ol class="lg-rest">'+rest+'</ol>':'')+'</article>';
  }
  async function loadLegends(){
    const grid=$("legendsGrid");if(!grid||!client)return;
    const mv=$("legendsMonth").value||monthNow;
    const label=new Date(mv+"-01T12:00:00").toLocaleDateString(undefined,{month:"long",year:"numeric"});
    grid.innerHTML='<div class="lg-empty">Loading…</div>';
    const [all,mon]=await Promise.all([client.rpc("get_top_performers",{p_month:null}),client.rpc("get_top_performers",{p_month:monthDate(mv)}),ensureAvatars()]);
    if(all.error||mon.error){grid.innerHTML='<div class="lg-empty">Could not load the stats.</div>';return;}
    grid.innerHTML=legendCard("goals","all",all.data,label)+legendCard("goals","month",mon.data,label)+legendCard("cs","all",all.data,label)+legendCard("cs","month",mon.data,label);
  }
  async function loadHomeLegends(){
    const box=$("homeLegends");if(!box||!client)return;
    try{
      const [r]=await Promise.all([client.rpc("get_top_performers",{p_month:monthDate(monthNow)}),ensureAvatars()]);
      const rows=r.data||[];
      const top=(k)=>[...rows].filter(x=>Number(x[k])>0).sort((x,y)=>Number(y[k])-Number(x[k])||Number(x.matches_played)-Number(y.matches_played)||String(x.player_name).localeCompare(y.player_name))[0];
      const g=top("goals_for"),c=top("clean_sheets");
      if(!g&&!c){box.classList.add("hidden");return;}
      const one=(x,k,label,unit)=>x?'<button type="button" class="hl-card" data-player="'+esc(x.player_id)+'">'+avBig(x.player_name,x.player_id,"hl-av")+'<span class="hl-txt"><small>'+label+'</small><b>'+esc(x.player_name)+'</b><em>'+x[k]+' '+unit+'</em></span></button>':'';
      box.innerHTML='<div class="hl-head"><h2>This month\'s stars</h2><span class="hl-links"><button type="button" class="hl-link" data-view="weekly">BPC Weekly</button><button type="button" class="hl-link" data-view="h2h">Head to Head &amp; BPC Stars</button></span></div><div class="hl-grid">'+one(g,"goals_for","Top scorer","goals")+one(c,"clean_sheets","Clean sheet king","clean sheets")+'</div>';
      box.querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.view)));
      box.classList.remove("hidden");
    }catch(e){console.warn(e);}
  }
  function initials(n){return String(n||"?").trim().split(/\s+/).slice(0,2).map(w=>w[0]||"").join("").toUpperCase()||"?";}
  function tnGlyph(format){
    const g={
      knockout:'<path d="M3 5h5v4H3zM3 15h5v4H3zM8 7h3v10H8M11 12h4M15 9h6v6h-6z"/>',
      round_robin:'<circle cx="12" cy="12" r="8"/><path d="M12 4v16M4 12h16M6.3 6.3l11.4 11.4M17.7 6.3L6.3 17.7"/>',
      group_knockout:'<rect x="3" y="4" width="7" height="7" rx="1"/><rect x="3" y="13" width="7" height="7" rx="1"/><path d="M10 7.5h4v9h-4M14 12h3"/><rect x="17" y="9" width="4" height="6" rx="1"/>',
      swiss:'<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M8.2 6h7.6M6 8.2v7.6M18 8.2v7.6M8.2 18h7.6M8 8l8 8"/>'
    }[format]||'<circle cx="12" cy="12" r="8"/>';
    return '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+g+'</svg>';
  }
  function timeLeft(iso){
    const ms=new Date(iso)-new Date();if(!(ms>0))return null;
    const m=Math.floor(ms/60000),d=Math.floor(m/1440),h=Math.floor((m%1440)/60);
    return d>0?d+"d "+h+"h":h>0?h+"h "+(m%60)+"m":(m%60)+"m";
  }
  function dueChip(iso,showNone){
    if(!iso)return showNone?'<span class="tn-due none">No deadline set</span>':'';
    const left=timeLeft(iso);
    return left?'<span class="tn-due" title="'+esc(fmtDeadline(iso))+'">Due in '+left+'</span>':'<span class="tn-due late">Deadline passed</span>';
  }
  // One fixture drawn as a scoreboard. In entry mode a score box sits beside each name.
  // o: {id,left:{name,you,score},right:{...},mode:"view"|"player"|"admin",done,mine,head,foot}
  function boardSide(sd,side,mode,done,res){
    const box=mode==="view"?(done?'<span class="tn-box tn-box-final">'+esc(sd.score)+'</span>':'')
      :'<input class="tn-box tn-box-in" type="number" inputmode="numeric" min="0" max="99" step="1" placeholder="0" data-side="'+side+'" aria-label="Score for '+esc(sd.name)+'" required>';
    return '<div class="tn-side tn-'+side+(sd.you?' is-you':'')+(res==="win"?' is-win':res==="lose"?' is-lose':'')+'"><span class="tn-av" aria-hidden="true"'+av(sd.name)+'>'+esc(initials(sd.name))+'</span><span class="tn-name">'+esc(sd.name)+(sd.you?'<em class="tn-you">You</em>':'')+'</span>'+box+'</div>';
  }
  function renderBoard(o){
    const lw=o.done&&o.left.score>o.right.score,rw=o.done&&o.right.score>o.left.score,entry=o.mode!=="view";
    const board='<div class="tn-board">'+boardSide(o.left,"a",o.mode,o.done,lw?"win":rw?"lose":"")+'<span class="tn-mid">'+(o.done?"–":"vs")+'</span>'+boardSide(o.right,"b",o.mode,o.done,rw?"win":lw?"lose":"")+'</div>';
    const foot='<div class="tn-foot">'+(o.foot||"")+(entry?'<button type="submit" class="primary">'+(o.mode==="admin"?"Save result":"Submit score")+'</button>':'')+'</div>';
    const cls='tn-match'+(o.mine?' mine':'')+(entry?' entry':'');
    return entry?'<form class="'+cls+'" data-score-form="'+esc(o.id)+'" data-kind="'+o.mode+'" data-name-a="'+esc(o.left.name)+'" data-name-b="'+esc(o.right.name)+'" novalidate>'+(o.head||"")+board+foot+'</form>'
      :'<article class="'+cls+'">'+(o.head||"")+board+foot+'</article>';
  }
  function bindScoreForms(root,done,fail){
    root.querySelectorAll("form[data-score-form]").forEach(f=>f.addEventListener("submit",async ev=>{
      ev.preventDefault();
      const ins=f.querySelectorAll(".tn-box-in"),a=ins[0].value.trim(),z=ins[1].value.trim();
      if(!/^\d{1,2}$/.test(a)||!/^\d{1,2}$/.test(z)){fail("Enter a whole-number score (0 to 99) in both boxes.");return;}
      const kind=f.dataset.kind;
      if(!confirm((kind==="admin"?"Save and approve ":"Submit ")+f.dataset.nameA+" "+a+" – "+z+" "+f.dataset.nameB+"?"))return;
      const btn=f.querySelector("button[type=submit]");btn.disabled=true;
      const args={p_match_id:f.dataset.scoreForm,p_score_a:Number(a),p_score_b:Number(z)};
      const {error}=kind==="admin"?await client.rpc("tournament_admin_enter_result",{...args,p_reason:"Admin-entered score"}):await client.rpc("tournament_submit_result",{...args,p_note:null});
      if(error){btn.disabled=false;fail(error.message);return;}
      done(kind);
    }));
  }
  async function openTournament(id){
    const {data:t,error}=await client.from("tournament_tournaments").select("*").eq("id",id).maybeSingle();
    if(error||!t){status("tournamentStatus",error?.message||"Tournament unavailable.","error");return;}
    const [pr,mr,sr,rr]=await Promise.all([
      client.from("tournament_participants").select("id,entrant_type,user_id,cobeg_member_id,external_name,status,seed,registered_at").eq("tournament_id",id).order("registered_at"),
      client.from("tournament_matches").select("id,stage_id,group_id,round_number,match_number,participant_a_id,participant_b_id,score_a,score_b,status,scheduled_at,deadline_at").eq("tournament_id",id).order("round_number").order("match_number"),
      client.from("tournament_stages").select("id,name,stage_type,sequence_number,status").eq("tournament_id",id).order("sequence_number"),
      client.from("tournament_result_submissions").select("id,match_id,score_a,score_b,status,note,created_at,submitted_by").in("match_id", (await client.from("tournament_matches").select("id").eq("tournament_id",id)).data?.map(m=>m.id)||[]).in("status",["pending","disputed","awaiting_opponent"]).order("created_at")
    ]);
    if(pr.error||mr.error||sr.error||rr.error){status("tournamentStatus",pr.error?.message||mr.error?.message||sr.error?.message||rr.error?.message||"Could not load tournament details.","error");return;}
    const participants=pr.data||[],matches=mr.data||[],stages=sr.data||[],pendingSubmissions=rr.data||[];
    // Group stage layout: group names, and which group each entrant sits in.
    const groupStageIds=stages.filter(s=>s.stage_type==="group").map(s=>s.id);
    const groupList=[],groupOf={};
    if(groupStageIds.length){
      const [gq,eq]=await Promise.all([
        client.from("tournament_groups").select("id,stage_id,name,sequence_number").in("stage_id",groupStageIds).order("sequence_number"),
        client.from("tournament_stage_entries").select("stage_id,participant_id,group_id,entry_status").in("stage_id",groupStageIds)
      ]);
      (gq.data||[]).forEach(g=>groupList.push(g));
      (eq.data||[]).filter(e=>e.group_id&&["active","qualified"].includes(e.entry_status)).forEach(e=>{const g=groupList.find(x=>x.id===e.group_id);if(g)groupOf[e.participant_id]=g.name;});
    }
    const mine=participants.find(p=>p.user_id===state.session?.user?.id&&!["withdrawn","rejected"].includes(p.status));
    const visibleParticipants=state.tnAdmin?participants:participants.filter(p=>p.status==="confirmed");
    const canRegister=!!state.session&&t.status==="registration_open"&&["self","both"].includes(t.registration_mode)&&!mine&&(!t.registration_deadline||new Date(t.registration_deadline)>new Date())&&(!t.participant_limit||participants.filter(p=>["pending","confirmed","waitlisted"].includes(p.status)).length<t.participant_limit);
    const entrantNames={};
    const accountIds=participants.map(p=>p.user_id).filter(Boolean);
    const memberIds=participants.map(p=>p.cobeg_member_id).filter(Boolean);
    const participantIds=participants.map(p=>p.id);
    if(accountIds.length){const q=await client.from("profiles").select("id,display_name").in("id",accountIds);(q.data||[]).forEach(x=>entrantNames[x.id]=x.display_name);}
    if(memberIds.length){const q=await client.from("cobeg_members").select("id,name").in("id",memberIds);(q.data||[]).forEach(x=>entrantNames[x.id]=x.name);}
    if(participantIds.length){const q=await client.from("tournament_teams").select("participant_id,team_name").in("participant_id",participantIds);(q.data||[]).forEach(x=>entrantNames[x.participant_id]=x.team_name);}
    const entrantLabel=p=>p.external_name||entrantNames[p.id]||entrantNames[p.user_id]||entrantNames[p.cobeg_member_id]||"Registered entrant";
    const uid=state.session?.user?.id,ended=TN_ENDED.includes(t.status);
    const myRes=state.session?await client.rpc("tournament_my_matches"):{data:[]};
    const myRows=(myRes.data||[]).filter(x=>x.tournament_id===id);
    const myMatchIds=new Set(myRows.map(x=>x.match_id));
    const myCanSubmit=new Set(myRows.filter(x=>x.can_submit).map(x=>x.match_id));
    const myPartIds=new Set([...participants.filter(p=>p.user_id===uid).map(p=>p.id),...myRows.map(x=>x.my_participant_id)]);
    const nameOf=pid=>{const p=participants.find(x=>x.id===pid);return p?entrantLabel(p):"TBD";};
    const renderFixtures=list=>{
      const rounds=[...new Set(list.map(m=>m.round_number))].sort((a,b)=>a-b);
      return rounds.map(rn=>{
        const rm=list.filter(m=>m.round_number===rn).sort((a,b)=>a.match_number-b.match_number);
        const dl=rm.map(m=>m.deadline_at).find(Boolean);
        const roundOpen=rm.some(m=>["scheduled","rejected"].includes(m.status));
        const head='<div class="tn-round"><b>Round '+rn+'</b>'+(roundOpen&&!ended?dueChip(dl,true):'')+(state.tnAdmin&&roundOpen&&!ended?'<button type="button" class="secondary" data-set-deadline="'+esc(rm[0].stage_id)+'" data-round="'+rn+'">'+(dl?'Change deadline':'Set deadline')+'</button>':'')+'</div>';
        const mkCard=m=>{
          const a=nameOf(m.participant_a_id);
          if(!m.participant_b_id)return '<div class="tn-bye"><span class="tn-av" aria-hidden="true"'+av(a)+'>'+esc(initials(a))+'</span><span><b>'+esc(a)+'</b> advances with a bye</span></div>';
          const b=nameOf(m.participant_b_id),done=["approved","completed"].includes(m.status),open=["scheduled","rejected"].includes(m.status);
          let mode="view";
          if(!ended&&state.tnAdmin&&t.score_workflow==="admin_entered"&&open)mode="admin";
          else if(myCanSubmit.has(m.id))mode="player";
          const foot='<span class="tn-meta">Match '+m.match_number+'</span>'
            +(open&&ended?'<span class="tn-due none">Not played</span>':open?dueChip(m.deadline_at,false):'')
            +(m.status==="rejected"?'<span class="tn-due late">Last score rejected</span>':'')
            +(TN_MATCH[m.status]?'<span class="tn-due none">'+esc(TN_MATCH[m.status])+'</span>':'');
          const mineA=myPartIds.has(m.participant_a_id),mineB=myPartIds.has(m.participant_b_id);
          return renderBoard({id:m.id,mode,done,foot,mine:mineA||mineB,left:{name:a,you:mineA,score:m.score_a},right:{name:b,you:mineB,score:m.score_b}});
        };
        const gids=[...new Set(rm.map(m=>m.group_id).filter(Boolean))];
        if(gids.length){
          const ordered=groupList.filter(g=>gids.includes(g.id));
          return head+ordered.map(g=>'<div class="tn-group-tag"><span>Group '+esc(g.name)+'</span></div><div class="tn-matches">'+rm.filter(m=>m.group_id===g.id).map(mkCard).join("")+'</div>').join("");
        }
        return head+'<div class="tn-matches">'+rm.map(mkCard).join("")+'</div>';
      }).join("");
    };
    const matchOf=mid=>matches.find(m=>m.id===mid);
    const queueBoard=x=>{const m=matchOf(x.match_id);if(!m)return'';return renderBoard({id:x.id,mode:"view",done:true,left:{name:nameOf(m.participant_a_id),score:x.score_a},right:{name:nameOf(m.participant_b_id),score:x.score_b},foot:'<span class="tn-meta">Round '+m.round_number+', match '+m.match_number+'</span><span class="tn-due none">'+esc(x.status.replaceAll("_"," "))+'</span>'+(x.note?'<span class="tn-meta">'+esc(x.note)+'</span>':'')});};
    const confirmedCount=participants.filter(p=>p.status==="confirmed").length;
    const nextDue=matches.filter(m=>["scheduled","rejected"].includes(m.status)&&m.deadline_at&&new Date(m.deadline_at)>new Date()).map(m=>m.deadline_at).sort()[0];
    const facts=[["Players",confirmedCount+(t.participant_limit?" of "+t.participant_limit:"")],["Format",TN_FORMAT[t.format]||t.format],["Scoring",TN_FLOW[t.score_workflow]||t.score_workflow]];
    if(nextDue&&!ended)facts.push(["Next score deadline",fmtDeadline(nextDue)]);
    else if(t.status==="registration_open"&&t.registration_deadline)facts.push(["Registration closes",tournamentDate(t.registration_deadline)]);
    const spotsLeft=t.participant_limit?Math.max(0,t.participant_limit-participants.filter(p=>["pending","confirmed","waitlisted"].includes(p.status)).length):null;
    const deadlinePassed=!!t.registration_deadline&&new Date(t.registration_deadline)<=new Date();
    const rc=(tone,title,text,extra)=>'<div class="tn-regcard '+tone+'"><div><b>'+title+'</b><span>'+text+'</span></div>'+(extra||"")+'</div>';
    let regBtn="";
    if(!ended){
      if(mine){
        const M={confirmed:["ok","You are in","You are confirmed. Your fixtures and deadlines will show here and on your dashboard."],pending:["wait","Waiting for approval","Your sign-up has been sent. An admin will confirm it."],waitlisted:["wait","You are on the waitlist","The tournament is full. You will be moved up if a place opens."]}[mine.status]||["wait","Registered","Status: "+mine.status];
        regBtn=rc(M[0],M[1],M[2]);
      }else if(canRegister){
        const bits=[];if(t.registration_requires_approval)bits.push("An admin approves each sign-up.");if(spotsLeft!==null)bits.push(spotsLeft+" place"+(spotsLeft===1?"":"s")+" left.");if(t.registration_deadline)bits.push("Closes "+tournamentDate(t.registration_deadline)+".");
        regBtn=rc("open",t.competition_type==="team"?"Register your team":"Join this tournament",bits.join(" ")||"Sign-ups are open.",'<button type="button" class="primary" id="tournamentSelfRegister">'+(t.competition_type==="team"?"Register a team":"Join tournament")+'</button>');
      }else if(t.status==="registration_open"){
        if(!state.session)regBtn=rc("open","Sign in to join","Sign-ups are open for members.",'<button type="button" class="primary" id="tnSignInBtn">Sign in</button>');
        else if(!["self","both"].includes(t.registration_mode))regBtn=rc("wait","Players are added by the admins","Sign-ups are not open for this tournament.");
        else if(deadlinePassed)regBtn=rc("wait","Sign-ups have closed","The registration deadline has passed.");
        else if(spotsLeft===0)regBtn=rc("wait","This tournament is full","No places are left.");
      }else if(t.status==="registration_closed")regBtn=rc("wait","Sign-ups are closed","Registration has ended for this tournament.");
      else if(t.status==="draft")regBtn=rc("wait","Not open yet","Sign-ups have not opened.");
    }
    const mineLine="";
    let adminBar="";
    if(state.tnAdmin){
      const setup=ended?'':'<button type="button" class="secondary" id="tournamentAddEntrant">Add entrant</button><button type="button" class="secondary" id="tournamentAddStage">Create stage</button><button type="button" class="secondary" id="tournamentSetupStages">Set up default stages</button>';
      const life=t.status==="draft"?'':t.status==="archived"?'<button type="button" class="secondary" id="tnRestore">Restore tournament</button>'+(t.hidden_at?'<button type="button" class="secondary" id="tnUnhide">Unhide</button>':'<button type="button" class="secondary" id="tnHide">Hide from list</button>'):ended?'<button type="button" class="secondary danger" id="tnArchive">Archive</button>':'<button type="button" class="secondary danger" id="tnEnd">End tournament</button><button type="button" class="secondary danger" id="tnArchive">Archive</button>';
      adminBar='<div class="tn-admin-bar" data-tn-actions>'+setup+life+'</div>';
    }
    const hero='<header class="tn-hero" id="tnHero"><div class="tn-hero-top"><button type="button" class="tn-back" id="tnBack"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>All tournaments</button>'+tnStateHtml(t.status)+'</div><h2>'+esc(t.name)+'</h2>'+(t.description?'<p class="tn-lede">'+esc(t.description)+'</p>':'')
      +'<div class="tn-chips"><span class="tn-chip">'+esc(TN_FORMAT[t.format]||t.format)+'</span><span class="tn-chip">'+(t.competition_type==="team"?"Team":"Individual")+'</span></div><ul class="tn-facts">'+facts.map(f=>'<li><span>'+esc(f[0])+'</span><b>'+esc(f[1])+'</b></li>').join("")+'</ul>'+regBtn+mineLine+adminBar+'</header>';
    const banner=ended?'<div class="tn-banner"><span><b>'+(t.status==="archived"?"This tournament is archived.":t.status==="cancelled"?"This tournament was cancelled.":"This tournament has ended.")+'</b> Fixtures and approved results stay here for reference. New fixtures and scores are closed.</span></div>':'';
    let checklist="";
    if(state.tnAdmin&&!ended){
      const pendingReg=participants.filter(p=>p.status==="pending").length,hasStages=stages.length>0,hasFixtures=matches.length>0;
      const steps=[
        {done:true,title:"Tournament created",hint:"Format and rules are saved."},
        {done:t.status!=="draft",title:"Open sign-ups",hint:t.status==="draft"?"Players cannot see or join it as a member until you open it.":"Open.",act:t.status==="draft"?["Open sign-ups","open"]:null},
        {done:confirmedCount>=2,title:"Confirm at least two players",hint:confirmedCount+" confirmed"+(pendingReg?", "+pendingReg+" waiting for your approval (see Participants below)":"")+".",act:["Add a player","entrant"]},
        {done:hasFixtures,title:hasStages?"Generate round 1":"Set up stages",hint:hasStages?"Pairs the confirmed players and can set a score deadline.":"Creates the groups or rounds for this format.",act:hasStages?["Generate round 1","generate"]:["Set up stages","stages"]},
        {done:matches.some(m=>["approved","completed"].includes(m.status)),title:"Review and approve scores",hint:pendingSubmissions.length?pendingSubmissions.length+" waiting for review below.":"Submitted scores appear in the review queue.",act:null}
      ];
      const cur=steps.findIndex(x=>!x.done);
      checklist='<section class="tn-check" aria-label="Setup checklist"><div class="tn-check-head"><h3>'+(cur<0?"Everything is set up":"Next steps")+'</h3><span class="small">'+steps.filter(x=>x.done).length+' of '+steps.length+' done</span></div><ol>'+steps.map((x,i)=>'<li class="'+(x.done?'done':i===cur?'now':'')+'"><span class="tn-check-dot">'+(x.done?'&#10003;':i+1)+'</span><div><b>'+esc(x.title)+'</b><small>'+esc(x.hint)+'</small></div>'+(i===cur&&x.act?'<button type="button" class="'+(i===cur?'primary':'secondary')+'" data-cl="'+x.act[1]+'">'+esc(x.act[0])+'</button>':'')+'</li>').join("")+'</ol></section>';
    }
    const queue=state.tnAdmin?'<section class="tn-section"><div class="tn-section-head"><h3>Results waiting for review</h3>'+(pendingSubmissions.length?'<span class="tn-count">'+pendingSubmissions.length+'</span>':'')+'</div>'+(pendingSubmissions.length?pendingSubmissions.map(x=>'<div class="tn-review">'+queueBoard(x)+'<div class="tn-actions"><button type="button" class="primary" data-review-result="'+esc(x.id)+'" data-review-decision="approve">Approve</button><button type="button" class="secondary" data-review-result="'+esc(x.id)+'" data-review-decision="reject">Reject</button><button type="button" class="secondary" data-review-result="'+esc(x.id)+'" data-review-decision="dispute">Dispute</button></div></div>').join(""):'<div class="tn-empty">Nothing waiting. Submitted scores will show up here for approval.</div>')+'</section>':'';
    const confirmList=!state.tnAdmin&&t.score_workflow==="participant_opponent_admin"?pendingSubmissions.filter(x=>x.status==="awaiting_opponent"&&x.submitted_by!==uid&&matches.some(m=>m.id===x.match_id&&(myPartIds.has(m.participant_a_id)||myPartIds.has(m.participant_b_id)))):[];
    const confirmHtml=confirmList.length?'<section class="tn-section"><div class="tn-section-head"><h3>Confirm your opponent’s score</h3></div>'+confirmList.map(x=>'<div class="tn-review">'+queueBoard(x)+'<div class="tn-actions"><button type="button" class="primary" data-confirm-result="'+esc(x.id)+'" data-confirm-value="true">Confirm score</button><button type="button" class="secondary" data-confirm-result="'+esc(x.id)+'" data-confirm-value="false">Dispute score</button></div></div>').join("")+'</section>':'';
    const fixturesHtml='<section class="tn-section"><div class="tn-section-head"><h3>Fixtures</h3></div>'+(stages.length?stages.map(s=>'<div class="tn-stage"><div class="tn-stage-head"><div><h4>'+esc(s.name)+'</h4><span class="small">'+esc(s.stage_type.replaceAll("_"," "))+', '+esc(s.status)+'</span></div><div class="tn-stage-actions">'+(state.tnAdmin&&!ended?(s.stage_type==="group"&&!matches.some(m=>m.stage_id===s.id)?'<button type="button" class="secondary" data-redraw-groups="'+esc(s.id)+'">Redraw groups</button>':'')+'<button type="button" class="primary" data-generate-stage="'+esc(s.id)+'">Generate next round</button>'+(t.format==="group_knockout"&&s.stage_type==="group"?'<button type="button" class="secondary" data-advance-groups="'+esc(id)+'">Advance group qualifiers</button>':''):'')+'<button type="button" class="secondary" data-stage-standings="'+esc(s.id)+'">Standings</button></div></div><div id="standings-'+esc(s.id)+'"></div>'+(renderFixtures(matches.filter(m=>m.stage_id===s.id))||'<div class="tn-empty">No fixtures in this stage yet.'+(state.tnAdmin&&!ended?' Generate round 1 once entrants are confirmed.':'')+'</div>')+'</div>').join(""):'<div class="tn-empty">Fixtures have not been generated yet.'+(state.tnAdmin&&!ended?' Set up stages, then generate round 1.':'')+'</div>')+'</section>';
    const peopleHtml='<section class="tn-section"><div class="tn-section-head"><h3>Participants</h3><span class="tn-count">'+visibleParticipants.length+'</span></div>'+(visibleParticipants.length?'<div class="tn-people">'+visibleParticipants.map(p=>{
      const nm=entrantLabel(p);
      const pill=p.status==="confirmed"?'<span class="pill good">confirmed</span>':p.status==="pending"?'<span class="pill pending">pending</span>':'<span class="pill">'+esc(p.status)+'</span>';
      const act=state.tnAdmin&&!ended?'<div class="tn-person-act">'+(p.status==="pending"?'<button type="button" class="approve-btn" data-participant-approve="'+esc(p.id)+'">Approve</button>':'')+(["pending","confirmed","waitlisted"].includes(p.status)?'<button type="button" class="reject-btn" data-participant-remove="'+esc(p.id)+'">Remove</button>':'')+'</div>':'';
      return '<div class="tn-person'+(p.status==="withdrawn"?' is-out':'')+'"><span class="tn-av" aria-hidden="true"'+av(nm,{uid:p.user_id})+'>'+esc(initials(nm))+'</span><div class="tn-person-main"><b>'+esc(nm)+(p.user_id===uid?'<em class="tn-you">You</em>':'')+'</b>'+(p.seed?'<span class="small">Seed '+esc(p.seed)+'</span>':'')+'</div>'+(groupOf[p.id]?'<span class="tn-gchip">Group '+esc(groupOf[p.id])+'</span>':'')+pill+act+'</div>';
    }).join("")+'</div>':'<div class="tn-empty">No participants yet.</div>')+'</section>';
    tnOpen=id;
    const detail=$("tournamentDetail");
    detail.innerHTML=hero+banner+checklist+confirmHtml+queue+fixturesHtml+peopleHtml;
    applyTnVisibility();
    $("tournamentSetupStages")?.addEventListener("click",async()=>{
      let groups=4,random=false;
      if(t.format==="group_knockout"){
        const ans=await askGroups(confirmedCount);
        if(!ans)return;groups=ans.groups;random=ans.random;
      }
      const {data,error}=await client.rpc("tournament_admin_setup_stages",{p_tournament_id:id,p_group_count:groups});
      if(error){status("tournamentStatus",error.message,"error");return;}
      if(random&&data?.group_stage_id){
        const sh=await client.rpc("tournament_admin_shuffle_groups",{p_stage_id:data.group_stage_id});
        if(sh.error){status("tournamentStatus",sh.error.message,"error");}
      }
      await openTournament(id);toast("Default stages created.");
    });
    $("tournamentAddEntrant")?.addEventListener("click",()=>tournamentShowAddEntrant(id));
    $("tnSignInBtn")?.addEventListener("click",()=>showView("account"));
    detail.querySelectorAll("[data-cl]").forEach(b=>b.addEventListener("click",async()=>{
      const k=b.dataset.cl;
      if(k==="open"){await publishTournament(id);await openTournament(id);}
      else if(k==="entrant")tournamentShowAddEntrant(id);
      else if(k==="stages")$("tournamentSetupStages")?.click();
      else if(k==="generate")detail.querySelector("[data-generate-stage]")?.click();
    }));
    document.querySelectorAll("[data-participant-approve]").forEach(b=>b.addEventListener("click",async()=>{
      if(!state.tnAdmin)return;
      const p=participants.find(x=>x.id===b.dataset.participantApprove);if(!p)return;
      if(!confirm("Approve "+entrantLabel(p)+"? They will become a confirmed participant."))return;
      b.disabled=true;
      const {error}=await client.rpc("tournament_admin_review_registration",{p_participant_id:p.id,p_decision:"confirmed",p_reason:null});
      if(error){b.disabled=false;status("tournamentStatus",error.message,"error");return;}
      await openTournament(id);toast("Registration approved.");
    }));
    document.querySelectorAll("[data-participant-remove]").forEach(b=>b.addEventListener("click",async()=>{
      if(!state.tnAdmin)return;
      const p=participants.find(x=>x.id===b.dataset.participantRemove);if(!p)return;
      if(!confirm("Remove "+entrantLabel(p)+" from this tournament? Their record is kept for audit and history."))return;
      const reason=prompt("Reason for removal (optional):");if(reason===null)return;
      b.disabled=true;
      const {error}=await client.rpc("tournament_admin_remove_participant",{p_participant_id:p.id,p_reason:reason.trim()||null});
      if(error){b.disabled=false;status("tournamentStatus",error.message,"error");return;}
      await openTournament(id);await loadTournaments();toast("Participant removed. Record kept for history.");
    }));
    document.querySelectorAll("[data-confirm-result]").forEach(b=>b.addEventListener("click",async()=>{
      const reason=b.dataset.confirmValue==="false"?(prompt("Reason for disputing this score (optional):")||null):null;
      const {error}=await client.rpc("tournament_confirm_result",{p_submission_id:b.dataset.confirmResult,p_confirm:b.dataset.confirmValue==="true",p_reason:reason});
      if(error){status("tournamentStatus",error.message,"error");return;}await openTournament(id);toast(b.dataset.confirmValue==="true"?"Score confirmed; awaiting admin approval.":"Score disputed; an admin will review it.");
    }));
    document.querySelectorAll("[data-review-result]").forEach(b=>b.addEventListener("click",async()=>{
      const reason=prompt("Review reason (optional):")||null;
      const {error}=await client.rpc("tournament_review_result",{p_submission_id:b.dataset.reviewResult,p_decision:b.dataset.reviewDecision,p_reason:reason});
      if(error){status("tournamentStatus",error.message,"error");return;}await openTournament(id);toast("Result review saved.");
    }));
    $("tournamentAddStage")?.addEventListener("click",async()=>{
      const name=prompt("Stage name (e.g. Group Stage or Final Bracket):");if(!name||!name.trim())return;
      const kind=prompt("Stage type: round_robin, knockout, group, swiss",t.format==="knockout"?"knockout":t.format==="swiss"?"swiss":"round_robin");
      if(!["round_robin","knockout","group","swiss"].includes((kind||"").trim())){status("tournamentStatus","Invalid stage type.","error");return;}
      const sequence=stages.reduce((n,x)=>Math.max(n,x.sequence_number),0)+1;
      const {error}=await client.rpc("tournament_admin_create_stage",{p_tournament_id:id,p_name:name.trim(),p_stage_type:kind.trim(),p_sequence:sequence});
      if(error){status("tournamentStatus",error.message,"error");return;}await openTournament(id);toast("Stage created.");
    });
    document.querySelectorAll("[data-advance-groups]").forEach(b=>b.addEventListener("click",async()=>{
      const answer=prompt("How many qualifiers per group?","2");if(answer===null)return;
      const count=Number(answer);if(!Number.isInteger(count)||count<1||count>8){status("tournamentStatus","Qualifiers per group must be 1–8.","error");return;}
      if(!confirm("Advance the top "+count+" entrant(s) from each group? Group results must be complete, and this cannot be repeated."))return;
      const {data,error}=await client.rpc("tournament_admin_advance_group_qualifiers",{p_tournament_id:b.dataset.advanceGroups,p_qualifiers_per_group:count});
      if(error){status("tournamentStatus",error.message,"error");return;}
      await openTournament(id);toast("Advanced "+data+" group qualifier(s) to the knockout stage.");
    }));
    document.querySelectorAll("[data-generate-stage]").forEach(b=>b.addEventListener("click",async()=>{
      const stageId=b.dataset.generateStage;const prior=matches.filter(m=>m.stage_id===stageId);const round=Math.max(0,...prior.map(m=>m.round_number))+1;
      const deadline=await askDeadline({title:"Publish round "+round,text:"This creates real fixtures from the currently confirmed participants. Set the date players must submit their scores by.",allowNone:true,confirmText:"Publish round"});
      if(deadline===null)return;
      b.disabled=true;
      const {error}=await client.rpc("tournament_admin_generate_round",{p_stage_id:stageId,p_round:round,p_publish:true,p_reason:null,p_deadline:deadline||null});
      if(error){b.disabled=false;status("tournamentStatus",error.message,"error");return;}await openTournament(id);toast("Round published.");
    }));
    document.querySelectorAll("[data-set-deadline]").forEach(b=>b.addEventListener("click",async()=>{
      if(!state.tnAdmin)return;
      const stageId=b.dataset.setDeadline,round=Number(b.dataset.round);
      const current=matches.find(m=>m.stage_id===stageId&&m.round_number===round&&m.deadline_at)?.deadline_at;
      const deadline=await askDeadline({title:"Round "+round+" deadline",text:"Applies to every match in this round that is still waiting for a score.",allowNone:true,defaultValue:current&&new Date(current)>new Date()?toLocalInput(new Date(current)):undefined});
      if(deadline===null)return;
      const {error}=await client.rpc("tournament_admin_set_round_deadline",{p_stage_id:stageId,p_round:round,p_deadline:deadline||null});
      if(error){status("tournamentStatus",error.message,"error");return;}await openTournament(id);toast(deadline?"Deadline saved.":"Deadline removed.");
    }));
    bindScoreForms(detail,kind=>{openTournament(id);toast(kind==="admin"?"Result saved and approved.":t.score_workflow==="participant_opponent_admin"?"Score submitted. Your opponent needs to confirm it.":"Score submitted. An admin will review it.");},msg=>{status("tournamentStatus",msg,"error");toast(msg);});
    $("tnBack")?.addEventListener("click",()=>{tnOpen=null;applyTnVisibility();loadTournaments();window.scrollTo({top:0,behavior:"smooth"});});
    $("tnEnd")?.addEventListener("click",()=>tnLifecycle(t,"completed"));
    $("tnArchive")?.addEventListener("click",()=>tnLifecycle(t,"archived"));
    $("tnRestore")?.addEventListener("click",()=>tnLifecycle(t,"completed"));
    $("tnHide")?.addEventListener("click",()=>tnHide(t,true));
    $("tnUnhide")?.addEventListener("click",()=>tnHide(t,false));
    detail.querySelectorAll("[data-redraw-groups]").forEach(b=>b.addEventListener("click",async()=>{
      if(!state.tnAdmin)return;
      if(!confirm("Draw the groups again at random? Players will be shuffled between groups. This is only possible before fixtures exist."))return;
      const {error}=await client.rpc("tournament_admin_shuffle_groups",{p_stage_id:b.dataset.redrawGroups});
      if(error){status("tournamentStatus",error.message,"error");return;}
      toast("Groups redrawn.");await openTournament(id);
    }));
    document.querySelectorAll("[data-stage-standings]").forEach(b=>b.addEventListener("click",async()=>{
      const stageId=b.dataset.stageStandings;const {data,error}=await client.rpc("tournament_standings_for_stage",{p_stage_id:stageId});
      if(error){status("tournamentStatus",error.message,"error");return;}
      const target=$("standings-"+stageId);
      const stg=stages.find(x=>x.id===stageId);
      const row=(x,i,q)=>'<tr'+(q&&i<q?' class="tn-q"':'')+'><td>'+esc(x.entrant_name)+'</td><td>'+x.played+'</td><td>'+x.wins+'</td><td>'+x.draws+'</td><td>'+x.losses+'</td><td>'+x.score_difference+'</td><td>'+x.points+'</td></tr>';
      const tbl=(rows,q)=>'<div class="table-wrap"><table><thead><tr><th>Entrant</th><th>P</th><th>W</th><th>D</th><th>L</th><th>Diff</th><th>Pts</th></tr></thead><tbody>'+rows.map((x,i)=>row(x,i,q)).join("")+'</tbody></table></div>';
      if(stg?.stage_type==="group"&&groupList.length){
        const rows=data||[],qn=t.format==="group_knockout"?2:0;
        const byGroup=groupList.filter(g=>g.stage_id===stageId).map(g=>({g,rows:rows.filter(x=>groupOf[x.participant_id]===g.name)}));
        target.innerHTML='<div class="tn-gstand">'+byGroup.map(x=>'<div><div class="tn-group-tag"><span>Group '+esc(x.g.name)+'</span></div>'+tbl(x.rows,qn)+'</div>').join("")+'</div>'+(qn?'<p class="small">The top '+qn+' in each group go through to the knockout stage.</p>':'');
      }else target.innerHTML=tbl(data||[],0);
    }));
    stages.filter(x=>x.stage_type==="group"&&matches.some(m=>m.stage_id===x.id)).forEach(x=>detail.querySelector('[data-stage-standings="'+x.id+'"]')?.click());
    $("tournamentSelfRegister")?.addEventListener("click",async()=>{
      if(!state.session||!["self","both"].includes(t.registration_mode))return;
      let error;
      if(t.competition_type==="team"){
        const teamName=await askText({title:"Name your team",text:"This is the name shown on fixtures and standings.",label:"Team name",placeholder:"e.g. Brahmanbaria Blasters",confirmText:"Register team",validate:v=>v.length>=2&&v.length<=100?"":"Team names need 2 to 100 characters."});if(!teamName)return;
        const result=await client.rpc("tournament_register_team",{p_tournament_id:id,p_team_name:teamName.trim()});error=result.error;
      }else{
        const result=await client.rpc("tournament_register_individual",{p_tournament_id:id});error=result.error;
      }
      if(error){status("tournamentStatus",error.message,"error");return;}
      const joined=await client.from("tournament_participants").select("status").eq("tournament_id",id).eq("user_id",state.session.user.id).not("status","in","(withdrawn,rejected)").maybeSingle();
      toast(joined.data?.status==="confirmed"?"You are in. Good luck!":joined.data?.status==="waitlisted"?"The tournament is full, so you are on the waitlist.":"Sign-up sent. An admin will confirm it.");await openTournament(id);await loadTournaments();
    });
    window.scrollTo({top:0,behavior:"smooth"});
  }


  async function tournamentShowAddEntrant(tournamentId){
    if(!state.tnAdmin)return;
    const detail=$("tournamentDetail");
    let panel=$("tournamentAddEntrantPanel");
    if(panel){panel.remove();return;}
    panel=document.createElement("div");panel.id="tournamentAddEntrantPanel";panel.className="panel";
    panel.innerHTML='<h3>Add registered entrant</h3><p class="small">Choose a registered website account or COBEG XI member.</p><label for="tournamentEntrantSelect">Registered member</label><select id="tournamentEntrantSelect"><option value="">Loading members…</option></select><div class="toolbar"><button type="button" class="primary" id="tournamentConfirmAddEntrant">Add selected member</button><button type="button" class="secondary" id="tournamentCancelAddEntrant">Cancel</button></div><p id="tournamentAddEntrantStatus" class="small"></p>';
    const anchor=$("tournamentAddEntrant");
    anchor?.closest(".tn-hero")?.insertAdjacentElement("afterend",panel);
    const [playersResult,membersResult]=await Promise.all([
      client.from("players").select("user_id,display_name,active").not("user_id","is",null).eq("active",true).order("display_name"),
      client.from("cobeg_members").select("id,name,active").eq("active",true).order("name")
    ]);
    const select=$("tournamentEntrantSelect");
    if(!select)return;
    if(playersResult.error||membersResult.error){select.innerHTML='<option value="">Could not load registered members</option>';status("tournamentAddEntrantStatus",playersResult.error?.message||membersResult.error?.message||"Could not load members.","error");return;}
    const options=[
      ...(playersResult.data||[]).map(p=>({value:"user:"+p.user_id,label:(p.display_name||"Registered account")+" · Website account",user_id:p.user_id})),
      ...(membersResult.data||[]).map(m=>({value:"member:"+m.id,label:m.name+" · COBEG XI member",cobeg_member_id:m.id}))
    ];
    const seen=new Set();
    select.innerHTML='<option value="">Choose a registered member</option>'+options.filter(o=>{if(seen.has(o.value))return false;seen.add(o.value);return true;}).map(o=>'<option value="'+esc(o.value)+'">'+esc(o.label)+'</option>').join("");
    if(!options.length)select.innerHTML='<option value="">No active registered members found</option>';
    $("tournamentCancelAddEntrant")?.addEventListener("click",()=>panel.remove());
    $("tournamentConfirmAddEntrant")?.addEventListener("click",async()=>{
      const chosen=options.find(o=>o.value===select.value);
      if(!chosen){status("tournamentAddEntrantStatus","Please select a member.","error");return;}
      const {error}=await client.rpc("tournament_admin_add_entrant",{
        p_tournament_id:tournamentId,p_entrant_type:"individual",
        p_display_name:(chosen.user_id||chosen.cobeg_member_id)?null:chosen.label.split(" · ")[0],
        p_user_id:chosen.user_id||null,p_cobeg_member_id:chosen.cobeg_member_id||null,p_seed:null
      });
      if(error){status("tournamentAddEntrantStatus",error.message,"error");return;}
      toast("Registered member added to tournament.");await openTournament(tournamentId);
    });
  }

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
    if(!state.session||!state.isAdmin){status("fundFormStatus","Only administrators can record donations.","error");return;}
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
      else{state.profile=null;state.player=null;state.isAdmin=false;state.tnAdmin=false;state.isTnManager=false;state.canAccessFunds=false;}
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
