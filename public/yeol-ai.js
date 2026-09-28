/* Yeol AI — OpenAI client integration */
(function(){
  'use strict';

  function mailContext(limit){
    return mails
      .filter(function(m){ return m.folder !== 'trash'; })
      .slice()
      .sort(function(a,b){ return String(b.createdAt || b.time || '').localeCompare(String(a.createdAt || a.time || '')); })
      .slice(0, limit || 10)
      .map(function(m){
        return [
          '보낸사람: ' + (m.from || ''),
          '받는사람: ' + (m.to || ''),
          '제목: ' + (m.subj || ''),
          '내용: ' + String(m.body || '').slice(0, 1200)
        ].join('\\n');
      }).join('\\n\\n---\\n\\n');
  }

  async function callYeolAI(action, payload){
    return await api('/api/ai', {
      method: 'POST',
      body: Object.assign({ action: action }, payload || {})
    });
  }

  function renderAI(){
    $('#aiMsgs').innerHTML = aiLog.map(function(m,i){
      return m.w === 'me'
        ? '<div class="bubble me">' + esc(m.t) + '</div>'
        : '<div class="bubble ai">' + esc(m.t) +
          (m.draft ? '<button class="btn primary use" data-i="' + i + '">작성창에서 열기</button>' : '') +
          '</div>';
    }).join('');
    $$('#aiMsgs .use').forEach(function(b){
      b.onclick = function(){ show('mail'); openCompose(aiLog[+b.dataset.i].draft); };
    });
    var el = $('#aiMsgs');
    el.scrollTop = el.scrollHeight;
  }

  window.askAI = async function(q){
    aiLog.push({w:'me', t:q});
    renderAI();
    try{
      var r = await callYeolAI('chat', {
        message:q,
        context:mailContext(10)
      });
      aiLog.push({w:'ai', t:r.answer});
    }catch(e){
      aiLog.push({w:'ai', t:'오류: ' + e.message});
    }
    renderAI();
  };

  async function makeAIDraft(){
    var subj = $('#cSub').value.trim();
    var to = $('#cTo').value.trim();
    var request = subj || '자연스러운 이메일';
    var btn = $('#cAi');
    btn.disabled = true;
    try{
      var r = await callYeolAI('draft', {
        message: request,
        recipient: to,
        subject: subj,
        mailBody: $('#cBody').value.trim(),
        context: mailContext(6)
      });
      $('#cBody').value = r.answer;
      toast('Yeol AI가 실제 AI 초안을 작성했어요. 내용을 확인하고 보내세요');
    }catch(e){
      toast(e.message);
    }finally{
      btn.disabled = false;
    }
  }

  $('#cAi').onclick = makeAIDraft;

  if (typeof renderReader === 'function') {
    var oldRenderReader = renderReader;
    renderReader = function(){
      oldRenderReader();
      var m = mails.find(function(x){ return x.id === sel; });
      var btn = $('#rSum');
      if (!m || !btn) return;
      btn.onclick = async function(){
        btn.disabled = true;
        $('#sumBox').innerHTML = '<div class="summary"><b>AI 요약</b><br>AI가 요약하는 중…</div>';
        try{
          var r = await callYeolAI('summarize', {
            subject: m.subj,
            mailBody: m.body
          });
          $('#sumBox').innerHTML = '<div class="summary"><b>AI 요약</b><br>' + esc(r.answer) + '</div>';
        }catch(e){
          $('#sumBox').innerHTML = '<div class="summary"><b>요약 오류</b><br>' + esc(e.message) + '</div>';
        }finally{
          btn.disabled = false;
        }
      };
    };
  }
})();