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
    if(!label) return;
    label.textContent = (T.state.status === "user" && T.state.pseudo) ? T.state.pseudo : "Connexion";
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
