/* Terminus : comptes joueurs (Supabase Auth).
 * Chargé en `defer` par toutes les pages, juste après supabase-js.
 * Expose window.TerminusAuth ; les pages s'abonnent avec TerminusAuth.onChange(fn).
 * state.status : "loading" | "guest" | "user" | "unavailable"
 */
(function(){
  "use strict";

  var SUPABASE_URL = "https://wubushemowkizczoogvg.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_T4k5fQbOQb5lRRt1q4E1XQ_AQTdYWAr";
  // Date de la version des CGU / politique de confidentialité en vigueur.
  // À changer à chaque modification des textes (l'acceptation est horodatée par version).
  var CGU_VERSION = "2026-09-24";

  var PSEUDO_RE = /^[\p{L}\p{N}_.' -]{3,18}$/u;
  var listeners = [];

  var T = window.TerminusAuth = {
    SUPABASE_URL: SUPABASE_URL,
    SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
    CGU_VERSION: CGU_VERSION,
    state: {status: "loading", user: null, pseudo: null, profile: null, event: null},
    client: null,
    onChange: function(fn){
      listeners.push(fn);
      try{ fn(T.state); }catch(e){}
    },
    // "" si le pseudo a un format valide, sinon le message à afficher
    pseudoError: function(p){
      p = (p || "").trim();
      if(p.length < 3) return "3 caractères minimum.";
      if(p.length > 18) return "18 caractères maximum.";
      if(!PSEUDO_RE.test(p)) return "Lettres, chiffres, espaces et _ . ' - uniquement.";
      return "";
    },
    // jeton de session à jour (rafraîchi si besoin) ou null
    getToken: function(){
      if(!T.client) return Promise.resolve(null);
      return T.client.auth.getSession().then(function(r){
        return r.data && r.data.session ? r.data.session.access_token : null;
      });
    },
    refreshProfile: function(){
      return T.client.auth.getSession().then(function(r){
        return applySession(r.data ? r.data.session : null, "PROFILE_UPDATED");
      });
    }
  };

  function emit(){
    updateNav();
    listeners.forEach(function(fn){ try{ fn(T.state); }catch(e){} });
  }

  function updateNav(){
    var label = document.getElementById("nav-account-label");
    if(label) label.textContent = (T.state.status === "user" && T.state.pseudo) ? "Mon compte" : "Connexion";
    updateAvatar();
  }

  // pastille ronde en haut à droite (initiale du pseudo), visible une fois connecté
  var AVATAR_CSS =
    ".acct-avatar{position:absolute;top:16px;right:16px;z-index:50;width:46px;height:46px;border-radius:50%;" +
    "display:flex;align-items:center;justify-content:center;text-decoration:none;" +
    "font-family:var(--font-display,\"Lexend Mega\",system-ui,sans-serif);font-weight:700;font-size:1.25rem;line-height:1;" +
    "background:var(--accent,#FFDE21);color:var(--accent-ink,#0a0a0a);" +
    "border:var(--bw,3px) solid var(--border,#0a0a0a);box-shadow:var(--shadow-sm,3px 3px 0 #0a0a0a);" +
    "transition:transform 140ms cubic-bezier(.23,1,.32,1),box-shadow 140ms cubic-bezier(.23,1,.32,1);}" +
    ".acct-avatar:hover{transform:translate(-1px,-1px);box-shadow:4px 4px 0 var(--border,#0a0a0a);}" +
    ".acct-avatar:active{transform:translate(2px,2px);box-shadow:0 0 0 var(--border,#0a0a0a);}" +
    ".acct-avatar:focus-visible{outline:3px solid var(--border,#0a0a0a);outline-offset:3px;}" +
    "@media (max-width:700px){.acct-avatar{top:12px;right:12px;width:40px;height:40px;font-size:1.05rem;}}" +
    "@media (prefers-reduced-motion:reduce){.acct-avatar{transition:none;}}";

  function updateAvatar(){
    if(!document.body) return;
    var el = document.getElementById("acct-avatar");
    var pseudo = T.state.status === "user" ? T.state.pseudo : null;
    if(!pseudo){ if(el) el.remove(); return; }
    if(!document.getElementById("acct-avatar-css")){
      var st = document.createElement("style");
      st.id = "acct-avatar-css";
      st.textContent = AVATAR_CSS;
      document.head.appendChild(st);
    }
    if(!el){
      el = document.createElement("a");
      el.id = "acct-avatar";
      el.className = "acct-avatar";
      el.href = "compte.html";
      document.body.appendChild(el);
    }
    el.textContent = (Array.from(pseudo)[0] || "?").toUpperCase();
    el.title = "Mon compte (" + pseudo + ")";
    el.setAttribute("aria-label", "Mon compte, connecté en tant que " + pseudo);
    if(/(^|\/)compte\.html$/.test(location.pathname)) el.setAttribute("aria-current", "page");
  }

  if(!window.supabase || !window.supabase.createClient){
    T.state = {status: "unavailable", user: null, pseudo: null, profile: null, event: null};
    emit();
    return;
  }

  var client = T.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "terminus-auth"}
  });

  function applySession(session, event){
    if(!session){
      T.state = {status: "guest", user: null, pseudo: null, profile: null, event: event};
      emit();
      return Promise.resolve(T.state);
    }
    return client.from("profiles")
      .select("pseudo, created_at, cgu_version, cgu_accepted_at")
      .eq("id", session.user.id)
      .maybeSingle()
      .then(function(r){
        var p = r.data || null;
        T.state = {status: "user", user: session.user, pseudo: p ? p.pseudo : null, profile: p, event: event};
        emit();
        return T.state;
      });
  }

  // Supabase recommande de ne pas appeler l'API directement dans ce callback.
  client.auth.onAuthStateChange(function(event, session){
    setTimeout(function(){ applySession(session, event); }, 0);
  });
})();
