"use strict";
/* ============================================================
   ui.js —— 视图层:渲染与交互,实现 engine 依赖的 view 接口
   不包含任何游戏规则逻辑
   ============================================================ */

const el={
  indicator:document.getElementById("dayIndicator"),
  square:document.getElementById("tableSquare"),
  title:document.getElementById("phaseTitle"),
  sub:document.getElementById("phaseSub"),
  logList:document.getElementById("logList"),
  actionBar:document.getElementById("actionBar"),
  overlayRoot:document.getElementById("overlayRoot"),
};

/* 圆桌座位定位:1 号位在正下方,顺时针排列 */
const POS=Array.from({length:9},(_,i)=>{
  const a=Math.PI/2+i*(2*Math.PI/9);
  return {x:50+39.5*Math.cos(a),y:50+39.5*Math.sin(a)};
});

/* ---------- 玩家昵称配置(纯 UI 展示,可随意增删改名) ----------
   游戏逻辑、对局记录与 LLM 提示词只使用座位号,完全不读取本数组;
   这里的人名仅用于座位牌和终局名单的显示。
   按座位顺序分配给 8 名 AI(跳过人类所在的座位)。 */
const SEAT_NICKS=["老猎户","王寡妇","教书先生","张屠户","陈货郎","李铁匠","阿花","三叔公"];

/* snapshot.players 恒按座位号升序 → 跳过人类座位,依次取昵称 */
function seatNickMap(snap){
  const m={};let ai=0;
  for(const p of (snap&&snap.players)||[]){
    m[p.id]=p.isHuman?"你":(SEAT_NICKS[ai++]||"村民");
  }
  return m;
}

/* ---------- 通用模态 ---------- */

function openModal(build){
  return new Promise(resolve=>{
    const ov=document.createElement("div");
    ov.className="overlay";
    const m=document.createElement("div");
    m.className="modal";
    build(m,value=>{ov.remove();resolve(value);});
    ov.appendChild(m);
    el.overlayRoot.appendChild(ov);
  });
}

function saveToFolder(text){
  return new Promise((resolve, reject)=>{
    if(!window.showDirectoryPicker){
      const date=new Date().toISOString().slice(0,10);
      const blob=new Blob([text],{type:"text/plain;charset=utf-8"});
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");
      a.href=url;a.download=`战局复盘_月夜狼人杀_${date}.txt`;
      document.body.appendChild(a);a.click();document.body.removeChild(a);
      URL.revokeObjectURL(url);
      resolve("已下载，请手动移入「战局复盘」文件夹");
      return;
    }
    showDirectoryPicker({mode:"readwrite",startIn:"documents",suggestedName:"战局复盘"})
      .then(handle=>{
        const date=new Date().toISOString().replace(/[:.]/g,"-").slice(0,19);
        handle.getOrCreateFile(`月夜狼人杀_${date}.txt`,{create:true})
          .then(fh=>fh.createWritable()
            .then(w=>{w.write(text);w.close();})
            .then(()=>resolve("已保存到「战局复盘」文件夹 ✓"))
            .catch(reject))
          .catch(reject);
      })
      .catch(e=>{
        if(e.name==="AbortError")resolve("");
        else reject(e);
      });
  });
}

/* ---------- view 接口 ---------- */

const view={
  _snap:null,
  _picking:null,
  fast:false,

  log(text,cls){
    const item=document.createElement("div");
    item.className="log-item "+(cls||"sys");
    item.textContent=text;
    el.logList.appendChild(item);
    el.logList.scrollTop=el.logList.scrollHeight;
  },

  clearLog(){
    el.logList.innerHTML="";
  },

  setStage(title,sub,isNight){
    el.title.textContent=title;
    el.sub.textContent=sub||"";
    el.square.classList.toggle("day",!isNight);
    el.square.classList.toggle("night",!!isNight);
    el.title.style.animation="none";
    void el.title.offsetHeight;
    el.title.style.animation="";
  },

  setIndicator(text){
    el.indicator.textContent=text;
  },

  /* snapshot: {players:[{id,alive,isHuman,roleText,roleClass,votes,justDied}]} */
  render(snap){
    this._snap=snap;
    this._redraw();
  },

  _redraw(){
    el.square.querySelectorAll(".seat").forEach(n=>n.remove());
    if(!this._snap)return;
    const nick=seatNickMap(this._snap);
    for(const p of this._snap.players){
      const b=document.createElement("button");
      b.type="button";
      b.className="seat";
      b.style.left=POS[p.id].x+"%";
      b.style.top=POS[p.id].y+"%";
      if(!p.alive)b.classList.add("dead");
      if(p.justDied)b.classList.add("just-died");
      if(this._picking&&this._picking.valid.has(p.id)&&p.alive){
        b.classList.add("clickable");
        b.addEventListener("click",()=>{
          if(!this._picking||!this._picking.valid.has(p.id)||!p.alive)return;
          const res=this._picking.res;
          this._picking=null;
          this._redraw();
          res(p.id);
        });
      }
      const num=document.createElement("div");
      num.className="seat-num";num.textContent=String(p.id+1);
      const nm=document.createElement("div");
      nm.className="seat-name";nm.textContent=nick[p.id];
      b.append(num,nm);
      if(p.roleText){
        const r=document.createElement("div");
        r.className="seat-role "+(p.roleClass||"");
        r.textContent=p.roleText;
        b.appendChild(r);
      }
      if(p.votes>0){
        const v=document.createElement("div");
        v.className="vote-badge";v.textContent=p.votes+"票";
        b.appendChild(v);
      }
      b.disabled=!p.alive;
      el.square.appendChild(b);
    }
  },

  pickSeat(validIds,prompt){
    return new Promise(res=>{
      this._picking={valid:new Set(validIds),res};
      this.setActions([],prompt+"(点击座位)");
      this._redraw();
    });
  },

  confirm(text,okLabel,cancelLabel){
    return openModal((m,close)=>{
      const p=document.createElement("p");
      p.className="role-desc";p.textContent=text;
      const row=document.createElement("div");
      row.className="btn-row";
      const ok=document.createElement("button");
      ok.type="button";ok.className="btn primary";ok.textContent=okLabel;
      ok.addEventListener("click",()=>close(true));
      const cancel=document.createElement("button");
      cancel.type="button";cancel.className="btn";cancel.textContent=cancelLabel;
      cancel.addEventListener("click",()=>close(false));
      row.append(ok,cancel);m.append(p,row);
    });
  },

  choice(text,options){
    return openModal((m,close)=>{
      const p=document.createElement("p");
      p.className="role-desc";p.textContent=text;
      const row=document.createElement("div");
      row.className="btn-row";
      options.forEach((opt,i)=>{
        const b=document.createElement("button");
        b.type="button";
        b.className="btn "+(i===0?"primary":"");
        b.textContent=opt;
        b.addEventListener("click",()=>close(i));
        row.appendChild(b);
      });
      m.append(p,row);
    });
  },

  /* options: [{key,label,cls?,...payload}],返回被点的 option 或 {key:'text',text} */
  askSpeech(options,hint){
    return new Promise(res=>{
      this.setActions(options,hint);
      for(const b of el.actionBar.querySelectorAll("button.btn[data-key]")){
        b.addEventListener("click",()=>{
          const opt=options.find(o=>String(o.key)===b.dataset.key);
          this.clearActions();
          res(opt);
        });
      }
      const input=document.createElement("input");
      input.type="text";input.className="text-input";
      input.placeholder="或者,自由说两句……";
      const send=document.createElement("button");
      send.type="button";send.className="btn";send.textContent="发言";
      send.addEventListener("click",()=>{
        const v=input.value.trim();
        if(!v)return;
        this.clearActions();
        res({key:"text",text:v});
      });
      input.addEventListener("keydown",e=>{
        if(e.key==="Enter"&&input.value.trim()){
          this.clearActions();
          res({key:"text",text:input.value.trim()});
        }
      });
      el.actionBar.append(input,send);
      input.focus();
    });
  },

  setActions(list,hint){
    el.actionBar.innerHTML="";
    if(hint){
      const h=document.createElement("span");
      h.className="action-hint";h.textContent=hint;
      el.actionBar.appendChild(h);
    }
    for(const a of list){
      const b=document.createElement("button");
      b.type="button";
      b.className="btn "+(a.cls||"");
      b.dataset.key=String(a.key||"");
      b.textContent=a.label;
      if(a.onClick)b.addEventListener("click",a.onClick);
      el.actionBar.appendChild(b);
    }
  },

  clearActions(){
    el.actionBar.innerHTML="";
  },

  /* data: {roleName, roleClass, desc, matesText|null} */
  openRoleModal(data){
    return openModal((m,close)=>{
      const h=document.createElement("h2");
      h.textContent="你的身份";
      const rn=document.createElement("div");
      rn.className="role-name "+data.roleClass;
      rn.textContent=data.roleName;
      const d=document.createElement("p");
      d.className="role-desc";d.textContent=data.desc;
      m.append(h,rn,d);
      if(data.matesText){
        const mate=document.createElement("p");
        mate.className="role-mates";mate.textContent=data.matesText;
        m.appendChild(mate);
      }
      const row=document.createElement("div");
      row.className="btn-row";
      const start=document.createElement("button");
      start.type="button";start.className="btn primary";start.textContent="天黑请闭眼";
      start.addEventListener("click",()=>close());
      row.appendChild(start);m.appendChild(row);
    });
  },

  /* data: {goodWin, story, revealList:[{id,alive,role,cls}], journalText} → 'again' | 'stay' | 'replay' */
  openEndModal(data){
    return openModal((m,close)=>{
      const h=document.createElement("h2");
      h.textContent=data.goodWin?"好人胜利":"狼人胜利";
      h.style.color=data.goodWin?"var(--gold)":"var(--blood)";
      const line=document.createElement("p");
      line.className="win-line";line.textContent=data.story;
      const grid=document.createElement("div");
      grid.className="reveal-grid";
      const nick=seatNickMap(this._snap);
      for(const rv of data.revealList){
        const d=document.createElement("div");
        d.className="rv "+(rv.cls||"");
        const who=document.createElement("span");
        who.textContent=nick[rv.id]+(rv.alive?"":"(出局)");
        const role=document.createElement("span");role.textContent=rv.role;
        d.append(who,role);
        grid.appendChild(d);
      }
      const row=document.createElement("div");
      row.className="btn-row";
      const again=document.createElement("button");
      again.type="button";again.className="btn primary";again.textContent="再来一局";
      again.addEventListener("click",()=>close("again"));
      const replay=document.createElement("button");
      replay.type="button";replay.className="btn gold";replay.textContent="复盘";
      replay.addEventListener("click",()=>close("replay"));
      const stay=document.createElement("button");
      stay.type="button";stay.className="btn";stay.textContent="查看战局";
      stay.addEventListener("click",()=>close("stay"));
      row.append(again,replay,stay);
      m.append(h,line,grid,row);
    });
  },

  openReplayModal(text){
    return openModal((m,close)=>{
      m.classList.add("modal-wide");
      const h=document.createElement("h2");
      h.textContent="复盘";
      const info=document.createElement("p");
      info.className="role-desc";
      info.textContent="上帝视角完整记录。可复制到剪贴板、下载为 txt 文件，或直接保存到「战局复盘」文件夹。";
      const body=document.createElement("div");
      body.className="replay-body";
      const pre=document.createElement("pre");
      pre.className="replay-text";
      pre.textContent=text;
      body.appendChild(pre);
      const row=document.createElement("div");
      row.className="btn-row";
      const dl=document.createElement("button");
      dl.type="button";dl.className="btn gold";dl.textContent="下载 .txt";
      dl.addEventListener("click",()=>{
        const blob=new Blob([text],{type:"text/plain;charset=utf-8"});
        const url=URL.createObjectURL(blob);
        const a=document.createElement("a");
        a.href=url;a.download=`月夜狼人杀_复盘_${new Date().toISOString().slice(0,10)}.txt`;
        document.body.appendChild(a);a.click();document.body.removeChild(a);
        URL.revokeObjectURL(url);
      });
      const copy=document.createElement("button");
      copy.type="button";copy.className="btn";copy.textContent="复制全文";
      copy.addEventListener("click",()=>{
        navigator.clipboard.writeText(text).then(
          ()=>{copy.textContent="已复制 ✓";setTimeout(()=>copy.textContent="复制全文",1500);},
          ()=>{copy.textContent="复制失败";setTimeout(()=>copy.textContent="复制全文",1500);}
        );
      });
      const back=document.createElement("button");
      back.type="button";back.className="btn";back.textContent="返回";
      back.addEventListener("click",()=>close());
      const save=document.createElement("button");
      save.type="button";save.className="btn primary";
      save.textContent="保存到战局复盘";
      save.addEventListener("click",()=>{
        save.disabled=true;save.textContent="保存中…";
        saveToFolder(text).then(msg=>{
          if(msg)save.textContent=msg;
          setTimeout(()=>{save.disabled=false;save.textContent="保存到战局复盘";},2000);
        }).catch(e=>{
          save.textContent="保存失败";
          setTimeout(()=>{save.disabled=false;save.textContent="保存到战局复盘";},2000);
        });
      });
      row.append(save,dl,copy,back);
      m.append(h,info,body,row);
    });
  },

  openRulesModal(){
    return openModal((m,close)=>{
      const h=document.createElement("h2");h.textContent="对局规则";

      const rules=RULES.ready();
      const allowSelfKnife=rules.allowSelfKnife;
      const witchCanSaveSelf=ruleWitchCanSaveSelf();
      const hunterCanShoot=ruleHunterCanShootOnPoison();
      const allIn=ruleIsAllIn();

      const body=document.createElement("div");
      body.className="rules-body";

      const makeRuleRow=(key,label,desc,invert)=>{
        const r=RULES.ready();
        const v=invert?!r[key]:r[key];
        const row=document.createElement("div");
        row.className="rule-row";
        const lbl=document.createElement("span");
        lbl.className="rule-label";
        lbl.innerHTML=label+(desc?`<small>${desc}</small>`:"");
        const toggle=document.createElement("span");
        toggle.className="toggle"+(v?" on":"");
        toggle.addEventListener("click",()=>{
          r[key]=invert?!r[key]:!r[key];
          toggle.classList.toggle("on");
        });
        row.append(lbl,toggle);
        return row;
      };

      const sec=document.createElement("div");
      sec.className="rules-section";
      const secTitle=document.createElement("h4");
      secTitle.className="rules-section-title";
      secTitle.textContent="当前规则";
      sec.appendChild(secTitle);

      sec.appendChild(makeRuleRow("allowSelfKnife","狼人可自刀","狼人可袭击狼队友或自己",false));
      sec.appendChild(makeRuleRow("witchCantSaveSelf","女巫可自救","解药可以救女巫自己",true));
      sec.appendChild(makeRuleRow("hunterDeadByPoison","猎人被毒可开枪","被毒杀时猎枪仍可响",false));

      const winRow=document.createElement("div");
      winRow.className="rule-row";
      const winLbl=document.createElement("span");
      winLbl.className="rule-label";
      winLbl.innerHTML="胜利条件<small>屠边 / 屠城</small>";
      const winOpts=document.createElement("span");
      winOpts.style.cssText="display:flex;gap:6px;flex:none";
      const mk=Object.entries({split:"屠边",all_in:"屠城"});
      for(const [k,txt] of mk){
        const b=document.createElement("button");
        b.type="button";
        b.className="btn ghost"+(rules.winCondition===k?" gold":"");
        b.textContent=txt;
        b.style.cssText="padding:4px 12px;font-size:12px;";
        b.addEventListener("click",()=>{
          RULES.ready().winCondition=k;
          winOpts.querySelectorAll("button").forEach(x=>x.classList.remove("gold"));
          b.classList.add("gold");
        });
        winOpts.appendChild(b);
      }
      winRow.append(winLbl,winOpts);
      sec.appendChild(winRow);

      body.appendChild(sec);

      const desc=document.createElement("div");
      desc.className="rules-body";
      desc.style.marginTop="12px";
      desc.innerHTML=
        "<p><b>配置</b> 九人标准局:狼人 ×3 · 村民 ×3 · 预言家 · 女巫 · 猎人。</p>"+
        (allowSelfKnife
          ?"<p><b>夜晚</b> 狼人可袭击任何存活玩家(含狼队友和自己)。</p>"
          :"<p><b>夜晚</b> 狼人只能袭击非狼人的存活玩家,不能自刀。</p>")
        +(witchCanSaveSelf
          ?"<p><b>女巫</b> 解药可以救自己;毒药整局限用一次。</p>"
          :"<p><b>女巫</b> 解药不能救自己;毒药整局限用一次。</p>")
        +(hunterCanShoot
          ?"<p><b>猎人</b> 被袭击、放逐或毒杀时都可开枪带走一人。</p>"
          :"<p><b>猎人</b> 被袭击或放逐时可开枪;被毒杀则不能开枪。</p>")
        +(allIn
          ?"<p><b>胜负</b> 屠城:狼人全出局=好人胜;狼数≥好人数=狼人胜。</p>"
          :"<p><b>胜负</b> 屠边:狼人全出局=好人胜;狼数≥神职或≥村民任一阵营=狼人胜。</p>");
      body.appendChild(desc);

      const row=document.createElement("div");
      row.className="btn-row";
      const mk2=(text,cls,fn)=>{
        const b=document.createElement("button");
        b.type="button";b.className="btn "+(cls||"");
        b.textContent=text;
        b.addEventListener("click",fn);
        row.appendChild(b);
      };
      mk2("保存配置","primary",()=>{
        RULES.save(RULES.ready());
        close();
      });
      mk2("恢复默认","",()=>{
        RULES.clear();
        close();
      });
      mk2("关闭","",()=>{RULES.load();close();});
      m.append(h,body,row);
    });
  },

  /* LLM 接入设置:OpenAI 兼容端点(接口地址 / API Key / 模型名) */
  openSettingsModal(){
    return openModal((m,close)=>{
      const h=document.createElement("h2");h.textContent="AI 设置";
      const body=document.createElement("div");
      body.className="rules-body";
      body.innerHTML=
        "<p>配置任意 <b>OpenAI 兼容接口</b>后,8 名 AI 玩家将改由大模型驱动:它们记得本局每天的死亡、发言与投票,自己推理、撒谎、站队、投票。不配置则使用内置规则 AI。</p>"+
        "<p>兼容 DeepSeek、通义千问、Kimi、智谱、Ollama 等。密钥只保存在本浏览器(localStorage),不会上传到别处。</p>";

      const fields=[["baseUrl","接口地址","https://api.deepseek.com/v1"],
        ["apiKey","API Key","sk-…"],["model","模型名","deepseek-chat"]];
      const inputs={};
      const cur=LLM.config||{};
      for(const [key,label,ph]of fields){
        const wrap=document.createElement("p");
        wrap.style.margin="10px 0 4px";
        const lab=document.createElement("div");
        lab.className="action-hint";lab.textContent=label;
        const input=document.createElement("input");
        input.type=key==="apiKey"?"password":"text";
        input.className="text-input";
        input.style.width="100%";
        input.placeholder=ph;
        input.value=cur[key]||"";
        wrap.append(lab,input);
        body.appendChild(wrap);
        inputs[key]=input;
      }
      const status=document.createElement("p");
      status.className="action-hint";
      status.style.minHeight="18px";
      status.textContent=LLM.ready()?"已配置,当前生效模型:"+LLM.config.model:"";
      body.appendChild(status);

      const apiLog=document.createElement("label");
      apiLog.style.cssText="display:flex;align-items:center;gap:6px;margin-top:8px;font-family:var(--sans);font-size:13px;color:var(--moon);cursor:pointer";
      const apiCb=document.createElement("input");
      apiCb.type="checkbox";apiCb.checked=!!(cur.recordApi||false);
      apiLog.append(apiCb,document.createTextNode("记录 LLM 原始调用到复盘文件(调试用,文件较大)"));
      body.appendChild(apiLog);

      const row=document.createElement("div");
      row.className="btn-row";
      const mk=(text,cls,fn)=>{
        const b=document.createElement("button");
        b.type="button";b.className="btn "+(cls||"");
        b.textContent=text;
        b.addEventListener("click",fn);
        row.appendChild(b);
      };
      mk("测试连接","",async btn=>{
        status.textContent="测试中……";
        LLM.config={baseUrl:inputs.baseUrl.value.trim(),
          apiKey:inputs.apiKey.value.trim(),model:inputs.model.value.trim(),
          recordApi:apiCb.checked};
        try{
          await LLM.chat("你是一个连通性测试。","请只回复:OK",{maxTokens:10,timeout:15000});
          status.textContent="连接成功 ✓";
        }catch(e){
          status.textContent="连接失败:"+e.message;
          LLM.load();
        }
      });
      mk("保存","primary",()=>{
        const cfg={baseUrl:inputs.baseUrl.value.trim(),
          apiKey:inputs.apiKey.value.trim(),model:inputs.model.value.trim(),
          recordApi:apiCb.checked};
        if(cfg.baseUrl&&cfg.apiKey&&cfg.model){
          LLM.save(cfg);
          close();
        }else{
          status.textContent="三项都要填写才能保存。";
        }
      });
      mk("清除","",()=>{
        LLM.clear();
        status.textContent="已清除,恢复内置规则 AI。";
        for(const k in inputs)inputs[k].value="";
        apiCb.checked=false;
      });
      mk("关闭","",()=>{LLM.load();close();});
      m.append(h,body,row);
    });
  },

  /* 开局着陆页:展示当前规则与 AI 状态,可先修改再开始 */
  openLanding(){
    return new Promise(res=>{
      const ov=document.createElement("div");
      ov.className="overlay";
      const m=document.createElement("div");
      m.className="modal landing";
      const h=document.createElement("h2");
      h.className="landing-title";h.textContent="月夜狼人杀";
      const sub=document.createElement("div");
      sub.className="landing-sub";sub.textContent="九人标准局 · 你与八个村民";
      const desc=document.createElement("p");
      desc.className="role-desc";
      desc.textContent="夜晚:狼人刀人、预言家查验、女巫用药。白天:轮流发言、投票放逐。";
      const ruleBox=document.createElement("div");
      ruleBox.className="landing-rules";
      const aiBox=document.createElement("div");
      aiBox.className="landing-ai";
      const refresh=()=>{
        const r=RULES.ready();
        ruleBox.innerHTML=
          "<div class='landing-rules-title'>当前规则</div>"+
          ["狼人可自刀 · "+(r.allowSelfKnife?"是":"否"),
           "女巫可自救 · "+(!r.witchCantSaveSelf?"是":"否"),
           "猎人被毒可开枪 · "+(r.hunterDeadByPoison?"是":"否"),
           "胜利条件 · "+(r.winCondition==="all_in"?"屠城":"屠边")]
          .map(l=>"<div class='landing-rules-row'>"+l+"</div>").join("");
        aiBox.textContent=LLM.ready()
          ?"AI · 大模型驱动: "+LLM.config.model
          :"AI · 内置规则 AI(可接入大模型)";
      };
      refresh();
      const row=document.createElement("div");
      row.className="btn-row";
      const mk=(text,cls,fn)=>{
        const b=document.createElement("button");
        b.type="button";b.className="btn "+(cls||"");b.textContent=text;
        b.addEventListener("click",async()=>{await fn();});
        row.appendChild(b);
      };
      mk("开始游戏","primary",()=>{ov.remove();res();});
      mk("修改规则","",async()=>{await view.openRulesModal();refresh();});
      mk("AI 设置","",async()=>{await view.openSettingsModal();refresh();});
      m.append(h,sub,desc,ruleBox,aiBox,row);
      ov.appendChild(m);
      el.overlayRoot.appendChild(ov);
    });
  },

  sleep(ms){
    return new Promise(r=>setTimeout(r,this.fast?Math.min(ms,70):ms));
  },
};

/* ---------- 顶栏按钮 ---------- */

document.getElementById("speedBtn").addEventListener("click",e=>{
  view.fast=!view.fast;
  e.target.textContent=view.fast?"常速":"加速";
});
document.getElementById("rulesBtn").addEventListener("click",()=>view.openRulesModal());
document.getElementById("llmBtn").addEventListener("click",()=>view.openSettingsModal());
