export function homeMarkup() {
    return `<main id="home" class="home-screen" aria-label="Furo home">
      <section class="home-stage" aria-label="Your character">
        <div class="home-stage-heading"><span class="eyebrow"><span class="small-line"></span>YOUR PLAYER</span><span class="tag">READY WHEN YOU ARE</span></div>
        <div id="home-character" role="img" aria-label="Your selected character"><span id="character-loading">PREPARING YOUR CHARACTER…</span></div>
        <div class="home-character-caption"><span class="home-class-index" id="home-class-index">01 / 04</span><div><span id="home-role">PRECISION</span><h2 id="home-class-name">HUNTER</h2></div><span class="home-stage-cross" aria-hidden="true">+</span></div>
      </section>
      <section class="home-controls" aria-labelledby="home-title">
        <div class="home-intro"><div class="eyebrow"><span class="small-line"></span>THIS IS YOUR ARENA</div><h1 id="home-title" tabindex="-1">MAKE YOUR<br>NEXT MOVE<span class="lime">.</span></h1><p>Round up your friends. See you in the yard.</p></div>
        <label class="home-profile" for="home-name"><span>YOUR CALLSIGN <small>MAKE IT YOURS ↙</small></span><input id="home-name" maxlength="16" spellcheck="false" autocomplete="nickname" placeholder="Your name"/></label>
        <div class="home-actions"><button id="home-create" class="deploy-button"><span>Create Lobby</span><span aria-hidden="true">↗</span></button><button id="home-join" class="secondary-button" aria-expanded="false" aria-controls="home-join-form"><span>Join Lobby</span><span aria-hidden="true">↗</span></button><form id="home-join-form" class="hidden"><label for="home-room-code">ROOM CODE</label><div class="input-button"><input id="home-room-code" maxlength="18" spellcheck="false" autocomplete="off" autocapitalize="characters" placeholder="AB7K4" aria-describedby="home-join-error"/><button type="submit">JOIN ↗</button></div><p id="home-join-error" role="status"></p></form><p class="home-action-note">YOUR LOBBY. YOUR RULES.</p></div>
      </section>
    </main>`;
}
