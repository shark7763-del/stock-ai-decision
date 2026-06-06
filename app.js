/* ===================================================================
   台股 AI 買賣決策系統  app.js
   純前端 / LocalStorage / 可部署 GitHub Pages
   =================================================================== */
'use strict';

/* ---------- 儲存層 ---------- */
const DB = {
  k:{stocks:'fj_stocks',holds:'fj_holds',trades:'fj_trades',cfg:'fj_cfg',coach:'fj_coach'},
  get(k,def){try{return JSON.parse(localStorage.getItem(k))??def}catch(e){return def}},
  set(k,v){localStorage.setItem(k,JSON.stringify(v))}
};
let stocks = DB.get(DB.k.stocks, []);
let holds  = DB.get(DB.k.holds, []);
let trades = DB.get(DB.k.trades, []);
let cfg    = DB.get(DB.k.cfg, {capital:1000000, risk:2});
let coach  = DB.get(DB.k.coach, {}); // {YYYY-MM-DD:{checks:{}}}
const save = ()=>{DB.set(DB.k.stocks,stocks);DB.set(DB.k.holds,holds);DB.set(DB.k.trades,trades);DB.set(DB.k.cfg,cfg);DB.set(DB.k.coach,coach)};
const uid = ()=>Date.now().toString(36)+Math.random().toString(36).slice(2,6);

/* ---------- 工具 ---------- */
const $ = s=>document.querySelector(s);
const $$ = s=>document.querySelectorAll(s);
const n = v=>{v=parseFloat(v);return isNaN(v)?0:v};
const fmt = v=>n(v).toLocaleString('en-US',{maximumFractionDigits:2});
const money = v=>(v<0?'-':'')+'$'+Math.abs(Math.round(v)).toLocaleString();
const pct = v=>(v>=0?'+':'')+n(v).toFixed(2)+'%';
const today = ()=>new Date().toISOString().slice(0,10);
const cls = v=>v>0?'pos':v<0?'neg':'';
function toast(m){const t=$('#toast');t.textContent=m;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2200)}

/* ===================================================================
   分析引擎
   =================================================================== */

/* 五鐵律：每項 20 分，滿分 100 */
function fiveRules(s){
  const items=[
    {n:'股價站上 20 日線', ok:n(s.price)>n(s.ma20)},
    {n:'20 日線向上(20MA>60MA)', ok:n(s.ma20)>n(s.ma60)},
    {n:'成交量 > 5 日均量', ok:n(s.volume)>n(s.vol5) && n(s.vol5)>0},
    {n:'KD 黃金交叉(K>D)', ok:n(s.k)>n(s.d) && n(s.k)<80},
    {n:'外資或投信買超', ok:n(s.foreign)>0 || n(s.trust)>0},
  ];
  const score=items.filter(i=>i.ok).length*20;
  return {score,items};
}
function lightOf(sc){return sc>=90?['light-90','綠燈']:sc>=80?['light-80','黃綠燈']:sc>=70?['light-70','黃燈']:sc>=60?['light-60','橘燈']:['light-0','紅燈']}

/* 低點偵測 / 抄底指數 0~100 */
function bottomIndex(s){
  const bias=n(s.ma20)?((n(s.price)-n(s.ma20))/n(s.ma20))*100:0;
  let sc=0; const f=[];
  // RSI 超賣
  const rsi=n(s.rsi);
  let r=rsi<=20?25:rsi<=30?20:rsi<=40?12:rsi<=50?5:0; sc+=r;
  f.push({n:`RSI ${rsi||'-'}`,p:r,max:25});
  // KD 低檔
  const k=n(s.k);
  let kd=k<=20?20:k<=30?14:k<=40?7:0; sc+=kd;
  f.push({n:`K 值 ${k||'-'}`,p:kd,max:20});
  // 均線乖離（負乖離＝超跌）
  let bs=bias<=-12?20:bias<=-8?15:bias<=-5?10:bias<=-2?5:0; sc+=bs;
  f.push({n:`20MA 乖離 ${bias.toFixed(1)}%`,p:bs,max:20});
  // 成交量縮（量縮止跌）
  const vr=n(s.vol5)?n(s.volume)/n(s.vol5):1;
  let vv=vr<=0.7?15:vr<=0.9?10:vr<=1.1?5:0; sc+=vv;
  f.push({n:`量能比 ${vr.toFixed(2)}`,p:vv,max:15});
  // 前波支撐
  const sup=n(s.support);
  let sp=0; if(sup>0){const d=Math.abs(n(s.price)-sup)/sup; sp=d<=0.02?10:d<=0.04?6:d<=0.07?3:0;} sc+=sp;
  f.push({n:'貼近前波支撐',p:sp,max:10});
  // 籌碼
  let cp=(n(s.foreign)>0||n(s.trust)>0)?10:(n(s.foreign)>=0)?4:0; sc+=cp;
  f.push({n:'籌碼回流',p:cp,max:10});
  sc=Math.min(100,Math.round(sc));
  let advice,risk;
  if(sc>=80){advice='積極布局';risk='低';}
  else if(sc>=60){advice='可分批布局';risk='中';}
  else if(sc>=40){advice='觀察';risk='中高';}
  else {advice='不適合進場';risk='高';}
  return {score:sc,prob:sc,advice,risk,factors:f};
}

/* 高點預警 / 逃命指數 0~100 */
function topIndex(s){
  let sc=0; const f=[];
  const rsi=n(s.rsi);
  let r=rsi>=80?25:rsi>=70?18:rsi>=65?10:0; sc+=r; f.push({n:`RSI 過熱 ${rsi||'-'}`,p:r,max:25});
  const k=n(s.k);
  let kd=k>=85?20:k>=80?14:k>=75?7:0; sc+=kd; f.push({n:`KD 鈍化 K${k||'-'}`,p:kd,max:20});
  const vr=n(s.vol5)?n(s.volume)/n(s.vol5):1;
  let vv=vr>=2.5?15:vr>=2?12:vr>=1.5?7:0; sc+=vv; f.push({n:`爆量 ${vr.toFixed(2)}x`,p:vv,max:15});
  let ma=n(s.price)<n(s.ma20)?15:n(s.price)<n(s.ma5)?7:0; sc+=ma; f.push({n:'跌破均線',p:ma,max:15});
  let fr=n(s.foreign)<0?15:n(s.foreign)===0?5:0; sc+=fr; f.push({n:'外資轉賣',p:fr,max:15});
  let mg=n(s.margin)>0?(n(s.margin)>=3000?10:5):0; sc+=mg; f.push({n:`融資暴增 ${fmt(s.margin)}`,p:mg,max:10});
  sc=Math.min(100,Math.round(sc));
  let advice,risk;
  if(sc>=80){advice='立即減碼 / 停利';risk='極高';}
  else if(sc>=60){advice='分批減碼';risk='高';}
  else if(sc>=40){advice='提高警覺、設好停利';risk='中';}
  else {advice='續抱觀察';risk='低';}
  return {score:sc,advice,risk,factors:f};
}

/* AI 目標價（波段 + 黃金分割 + 平台突破） */
function targetPrices(s){
  const price=n(s.price), hi=n(s.prevHigh), lo=n(s.prevLow), ph=n(s.platform);
  let t1,t2,t3,basis;
  if(hi>lo && lo>0){
    const r=hi-lo;
    if(price>=hi){ t1=hi+r*0.382; t2=hi+r*0.618; t3=hi+r*1.0; basis='突破前高，黃金分割延伸'; }
    else { t1=hi; t2=hi+r*0.382; t3=hi+r*0.618; basis='前高壓力＋分割延伸'; }
  } else if(ph>0){
    t1=price+ph; t2=price+ph*1.618; t3=price+ph*2.618; basis='平台突破高度測幅';
  } else {
    t1=price*1.08; t2=price*1.15; t3=price*1.25; basis='預設波段(8/15/25%)';
  }
  return {t1,t2,t3,basis,price};
}

/* AI 股票人格分類 */
function persona(s){
  const price=n(s.price),ma5=n(s.ma5),ma10=n(s.ma10),ma20=n(s.ma20),ma60=n(s.ma60);
  const rsi=n(s.rsi),macd=n(s.macd);
  const bias=ma20?((price-ma20)/ma20)*100:0;
  const vr=n(s.vol5)?n(s.volume)/n(s.vol5):1;
  const bull=price>ma5&&ma5>ma10&&ma10>ma20&&ma20>ma60;
  const sc={};
  sc['猛虎型']=(bull?40:0)+(price>ma20?15:0)+(rsi>=55&&rsi<=72?20:0)+((n(s.foreign)>0||n(s.trust)>0)?15:0)+(macd>0?10:0);
  sc['獵豹型']=(vr>=2?35:vr>=1.5?18:0)+(rsi>=70?25:rsi>=60?12:0)+(macd>0?15:0)+(bias>=5?15:0);
  sc['火山型']=(Math.abs(bias)>=10?35:Math.abs(bias)>=6?18:0)+(vr>=2.2?25:0)+(rsi>=75||rsi<=25?20:0);
  sc['盾牌型']=(Math.abs(bias)<3?30:Math.abs(bias)<5?15:0)+(rsi>=40&&rsi<=60?25:0)+(vr<1.2?20:0)+(price>ma60?10:0);
  sc['成長型']=(price>ma60?25:0)+(ma20>ma60?25:0)+(rsi>=45&&rsi<=65?20:0)+(bull?10:0);
  let best='盾牌型',bv=-1; for(const k in sc) if(sc[k]>bv){bv=sc[k];best=k}
  const meta={'猛虎型':{e:'🐯',d:'強勢主升段，順勢操作為主'},'獵豹型':{e:'🐆',d:'短線飆股，快進快出嚴設停損'},
    '盾牌型':{e:'🛡',d:'防禦型，波動低、適合資金停泊'},'火山型':{e:'🌋',d:'高波動，部位要小、紀律要硬'},'成長型':{e:'🌱',d:'長期趨勢股，可逢低分批'}};
  return {type:best,emoji:meta[best].e,desc:meta[best].d};
}

/* 綜合狀態（給儀表板分類） */
function statusOf(s){
  const fr=fiveRules(s).score, top=topIndex(s).score;
  if(top>=60) return 'danger';
  if(fr>=80) return 'strong';
  return 'observe';
}

/* AI 總分（狀態卡用） */
function aiTotal(s){
  const fr=fiveRules(s).score, bi=bottomIndex(s).score, top=topIndex(s).score;
  return Math.round(0.45*fr + 0.3*bi + 0.25*(100-top));
}

/* ---- 大盤濾網 ---- */
function getMarket(){
  if(!cfg.market) cfg.market={twPrice:0,twMa20:0,twMa60:0,otcPrice:0,otcMa20:0,otcMa60:0};
  return cfg.market;
}
function idxTrend(p,m20,m60){p=n(p);m20=n(m20);m60=n(m60);if(!p)return 0;let s=0;if(p>m20)s+=40;if(m20>m60)s+=30;if(p>m60)s+=30;return s;}
function marketInfo(){
  const m=getMarket();
  const tw=idxTrend(m.twPrice,m.twMa20,m.twMa60);
  const otc=idxTrend(m.otcPrice,m.otcMa20,m.otcMa60);
  const has=n(m.twPrice)>0||n(m.otcPrice)>0;
  const trend=Math.round(0.6*tw+0.4*otc);
  const risk=Math.round(100-trend);
  const state=!has?'未設定':trend>=66?'多方':trend>=40?'盤整':'空方';
  return {tw,otc,trend,risk,state,has};
}

/* ---- 進場三階段 A/B/C 區 ---- */
function entryZone(s){
  const fr=fiveRules(s).score, bi=bottomIndex(s).score;
  const price=n(s.price),ma5=n(s.ma5),ma10=n(s.ma10),ma20=n(s.ma20),ma60=n(s.ma60),rsi=n(s.rsi),macd=n(s.macd);
  const bull=price>ma5&&ma5>ma10&&ma10>ma20&&ma20>ma60;
  const volUp=n(s.vol5)?n(s.volume)>n(s.vol5):false;
  if(bull&&fr>=80&&rsi>=55&&rsi<=75&&macd>=0) return {z:'C',label:'C區 · 主升段加碼',desc:'多頭排列＋五鐵律強，順勢加碼但控制總部位上限'};
  if(price>ma20&&n(s.k)>n(s.d)&&volUp&&fr>=60) return {z:'B',label:'B區 · 起漲確認',desc:'站上20MA＋KD轉強＋量增，可正式建立基本部位'};
  if(bi>=60) return {z:'A',label:'A區 · 低點試單',desc:'抄底指數偏高，僅小量試單、嚴設停損'};
  return null;
}

/* ---- 禁止進場條件 ---- */
function forbidEntry(s){
  const reasons=[];
  const price=n(s.price), ma20=n(s.ma20);
  const bias=ma20?((price-ma20)/ma20)*100:0;
  const tp=targetPrices(s);
  const stopPrice=price*(1-0.08), lossPerShare=price-stopPrice;
  const rr=(lossPerShare>0)?(tp.t1-price)/lossPerShare:0;
  const top=topIndex(s).score;
  const mk=marketInfo();
  const cap=n(cfg.capital)||0, oneLotRisk=lossPerShare*1000;
  if(rr>0 && rr<1.5) reasons.push(`風險報酬比 ${rr.toFixed(2)} < 1 : 1.5`);
  if(bias>8) reasons.push(`正乖離 20MA ${bias.toFixed(1)}% > 8%`);
  if(top>70) reasons.push(`逃命指數 ${top} > 70`);
  if(cap && oneLotRisk>cap*0.02) reasons.push(`單筆風險(最小1張) 超過總資金 2%`);
  if(mk.has && mk.risk>70) reasons.push(`大盤風險指數 ${mk.risk} > 70`);
  return reasons;
}

/* ---- 出場分級 ---- */
function exitGrade(score){
  if(score>=80) return {g:'全部出場',cls:'stop',pct:100};
  if(score>=60) return {g:'減碼 50%',cls:'stop',pct:50};
  if(score>=40) return {g:'減碼 30%',cls:'watch',pct:30};
  return {g:'續抱',cls:'go',pct:0};
}

/* ===================================================================
   投組 / 統計計算
   =================================================================== */
function holdMetrics(){
  let invested=0,pnl=0;
  holds.forEach(h=>{const cost=n(h.buy)*n(h.shares)*1000; invested+=cost; pnl+=(n(h.price)-n(h.buy))*n(h.shares)*1000;});
  return {invested,pnl,roi:invested?pnl/invested*100:0,count:holds.length};
}
function tradeStats(){
  const wins=trades.filter(t=>n(t.pnl)>0), losses=trades.filter(t=>n(t.pnl)<0);
  const gp=wins.reduce((a,t)=>a+n(t.pnl),0), gl=losses.reduce((a,t)=>a+n(t.pnl),0);
  // 連勝連敗
  let mw=0,ml=0,cw=0,cl=0;
  trades.slice().sort((a,b)=>(a.sellDate||'').localeCompare(b.sellDate||'')).forEach(t=>{
    if(n(t.pnl)>0){cw++;cl=0;mw=Math.max(mw,cw);} else if(n(t.pnl)<0){cl++;cw=0;ml=Math.max(ml,cl);}
  });
  return {
    total:trades.length, win:wins.length, loss:losses.length,
    winRate:trades.length?wins.length/trades.length*100:0,
    grossProfit:gp, grossLoss:gl, net:gp+gl,
    avgWin:wins.length?gp/wins.length:0, avgLoss:losses.length?gl/losses.length:0,
    maxWin:wins.length?Math.max(...wins.map(t=>n(t.pnl))):0,
    maxLoss:losses.length?Math.min(...losses.map(t=>n(t.pnl))):0,
    maxWinStreak:mw, maxLossStreak:ml
  };
}

/* ===================================================================
   渲染
   =================================================================== */
function renderAll(){renderDashboard();renderWar();renderScreener();renderEntrySel();renderExitSel();renderHoldings();renderTrades();renderStats();renderCoach();$('#poolCountBadge').textContent=stocks.length+' 檔追蹤';}

/* ---- 今日作戰室 ---- */
function holdToStock(h){return {code:h.code,name:h.name,price:h.price,ma5:h.ma5,ma10:h.ma10,ma20:h.ma20,ma60:h.ma60,rsi:h.rsi,k:h.k,d:h.d,macd:h.macd,volume:h.volume,vol5:h.vol5,foreign:h.foreign,trust:h.trust,margin:h.margin,support:h.support,prevHigh:h.prevHigh,prevLow:h.prevLow,platform:h.platform};}
function renderWar(){
  const mk=marketInfo();
  const banner=$('#warBanner');
  const stCls=mk.state==='多方'?'go':mk.state==='空方'?'stop':mk.state==='盤整'?'watch':'';
  banner.className='card glass war-banner '+stCls;
  const icon=mk.state==='多方'?'📈':mk.state==='空方'?'📉':mk.state==='盤整'?'➡️':'⚙️';
  banner.innerHTML=`<div class="wb-state">${icon} 今日大盤：${mk.state}</div>
    <div class="wb-sub">${mk.has?`綜合趨勢分 ${mk.trend} · 大盤風險指數 ${mk.risk}`:'尚未設定大盤數據 — 點下方「設定大盤數據」輸入加權／櫃買指數'}</div>`;
  $('#mTw').textContent=mk.has?mk.tw:'—';
  $('#mOtc').textContent=mk.has?mk.otc:'—';
  $('#mRisk').textContent=mk.has?mk.risk:'—';
  $('#marketNote').textContent=!mk.has?'':mk.risk>70?'⚠️ 大盤風險指數 >70：系統自動禁止所有個股進場（保護機制）。':mk.state==='空方'?'空方環境：僅做 A 區小量試單、降低總部位。':mk.state==='盤整'?'盤整環境：嚴選高分標的、快進快出。':'多方環境：可順勢操作，優先 B／C 區。';

  const entryL=[],obsL=[],forbL=[];
  stocks.forEach(s=>{
    const forb=forbidEntry(s), zone=entryZone(s), ai=aiTotal(s);
    if(forb.length) forbL.push({s,info:forb[0],ai});
    else if(zone) entryL.push({s,zone,ai});
    else obsL.push({s,ai});
  });
  entryL.sort((a,b)=>b.ai-a.ai);obsL.sort((a,b)=>b.ai-a.ai);forbL.sort((a,b)=>b.ai-a.ai);
  const item=(id,left,right,rc)=>`<div class="war-item" onclick="showCard('${id}')"><span>${left}</span><span class="${rc||''}">${right}</span></div>`;
  $('#warEntry').innerHTML=entryL.length?entryL.map(r=>item(r.s.id,`${r.s.code} ${r.s.name||''}`,`<span class="zone-pill zone-${r.zone.z}">${r.zone.z}區</span> AI ${r.ai}`)).join(''):'<p class="muted">今日無符合進場條件標的</p>';
  $('#warObserve').innerHTML=obsL.length?obsL.map(r=>item(r.s.id,`${r.s.code} ${r.s.name||''}`,`AI ${r.ai}`)).join(''):'<p class="muted">無</p>';
  $('#warForbid').innerHTML=forbL.length?forbL.map(r=>item(r.s.id,`${r.s.code} ${r.s.name||''}`,r.info,'neg')).join(''):'<p class="muted">無</p>';

  const reduceL=[],stopL=[];
  holds.forEach(h=>{
    const top=topIndex(holdToStock(h)).score, g=exitGrade(top);
    if(g.pct>0) reduceL.push({h,top,g});
    if(n(h.stop)>0&&n(h.price)>0&&n(h.price)<=n(h.stop)) stopL.push(h);
  });
  reduceL.sort((a,b)=>b.top-a.top);
  $('#warReduce').innerHTML=reduceL.length?reduceL.map(r=>`<div class="war-item" onclick="showCard('${r.h.id}')"><span>${r.h.code} ${r.h.name||''}</span><span class="${r.g.cls==='stop'?'neg':''}">逃命 ${r.top} · ${r.g.g}</span></div>`).join(''):'<p class="muted">持股無減碼警示</p>';
  $('#warStop').innerHTML=stopL.length?stopL.map(h=>`<div class="war-item" onclick="showCard('${h.id}')"><span>${h.code} ${h.name||''}</span><span class="neg">現價 ${fmt(h.price)} ≤ 停損 ${fmt(h.stop)}</span></div>`).join(''):'<p class="muted">無持股觸及停損</p>';
}

/* ---- 股票狀態卡 ---- */
function showCard(id){
  let s=stocks.find(x=>x.id===id), isHold=false, holdRef=null;
  if(!s){holdRef=holds.find(x=>x.id===id); if(holdRef){s=holdToStock(holdRef);isHold=true;}}
  if(!s)return;
  const fr=fiveRules(s).score,[lc]=lightOf(fr),bi=bottomIndex(s).score,top=topIndex(s).score,tp=targetPrices(s),pe=persona(s),ai=aiTotal(s);
  const zone=entryZone(s), forb=forbidEntry(s);
  const stopPrice=(holdRef&&n(holdRef.stop)>0)?n(holdRef.stop):n(s.price)*0.92;
  let action,acls;
  if(isHold){const g=exitGrade(top);action=(top>=60?'🔴 ':top>=40?'🟠 ':'🟢 ')+g.g;acls=g.cls;}
  else if(forb.length){action='⛔ 禁止進場';acls='stop';}
  else if(zone){action='🟢 '+zone.label;acls=zone.z==='A'?'watch':'go';}
  else if(top>=60){action='🔴 '+exitGrade(top).g;acls='stop';}
  else {action='🟡 觀察';acls='watch';}
  openModal(`<h3>📇 股票狀態卡</h3>
   <div class="stock-card">
     <div class="sc-head">
       <div><div class="sc-name">${s.code} ${s.name||''}</div><span class="persona">${pe.emoji}${pe.type}</span> <span class="muted">${pe.desc}</span></div>
       <div class="sc-ai"><div class="sc-ai-num">${ai}</div><div class="k">AI 總分</div></div>
     </div>
     <div class="sc-grid">
       <div><span class="k">五鐵律</span><b class="pill ${lc}">${fr}</b></div>
       <div><span class="k">抄底指數</span><b>${bi}</b></div>
       <div><span class="k">逃命指數</span><b>${top}</b></div>
       <div><span class="k">停損價</span><b>${stopPrice.toFixed(2)}</b></div>
       <div><span class="k">目標價</span><b>${tp.t1.toFixed(2)}</b></div>
       <div><span class="k">人格</span><b>${pe.emoji}${pe.type}</b></div>
     </div>
     <div class="sc-action ${acls}">${action}</div>
     ${forb.length&&!isHold?`<div class="muted">禁止原因：${forb.join('、')}</div>`:''}
   </div>
   <div class="modal-foot"><button class="btn primary" onclick="closeModal()">關閉</button></div>`);
}

/* ---- 大盤數據設定 ---- */
function marketForm(){
  const m=getMarket();
  openModal(`<h3>🌐 設定大盤數據</h3>
  <p class="muted" style="margin-bottom:8px">輸入加權／櫃買指數的現價與均線，系統計算趨勢分與大盤風險指數，並據此影響個股進場建議。</p>
  <div class="form-grid">
    ${field('加權指數 現價','m_twPrice',m.twPrice)}${field('加權 20MA','m_twMa20',m.twMa20)}
    ${field('加權 60MA','m_twMa60',m.twMa60,'number',true)}
    ${field('櫃買指數 現價','m_otcPrice',m.otcPrice)}${field('櫃買 20MA','m_otcMa20',m.otcMa20)}
    ${field('櫃買 60MA','m_otcMa60',m.otcMa60,'number',true)}
  </div>
  <div class="modal-foot"><button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveMarket()">儲存</button></div>`);
}
function saveMarket(){
  const g=k=>$('#m_'+k).value;
  cfg.market={twPrice:g('twPrice'),twMa20:g('twMa20'),twMa60:g('twMa60'),otcPrice:g('otcPrice'),otcMa20:g('otcMa20'),otcMa60:g('otcMa60')};
  save();closeModal();renderAll();toast('大盤數據已更新');
}

/* ---- 儀表板 ---- */
let charts={};
function renderDashboard(){
  $('#todayDate').textContent = new Date().toLocaleDateString('zh-TW',{year:'numeric',month:'long',day:'numeric',weekday:'long'});
  const hm=holdMetrics(), ts=tradeStats();
  // 市場溫度 / 風險
  let temp=0,risk=0,strong=0,observe=0,danger=0;
  stocks.forEach(s=>{temp+=fiveRules(s).score;risk+=topIndex(s).score;const st=statusOf(s);if(st==='strong')strong++;else if(st==='danger')danger++;else observe++;});
  temp=stocks.length?Math.round(temp/stocks.length):0;
  risk=stocks.length?Math.round(risk/stocks.length):0;
  const ai=Math.round(0.6*temp+0.4*(100-risk));
  $('#dbTemp').textContent=temp; $('#dbTempBar').style.width=temp+'%';
  $('#dbRisk').textContent=risk; $('#dbRiskBar').style.width=risk+'%';
  $('#dbHoldCount').textContent=hm.count;
  $('#dbInvested').textContent=money(hm.invested);
  const pe=$('#dbPnl'); pe.textContent=money(hm.pnl); pe.className='kpi-val '+cls(hm.pnl);
  const re=$('#dbRoi'); re.textContent=pct(hm.roi); re.className='kpi-val '+cls(hm.roi);
  $('#dbWin').textContent=ts.winRate.toFixed(1)+'%';
  const ne=$('#dbNet'); ne.textContent=money(ts.net); ne.className='kpi-val '+cls(ts.net);
  $('#dbStrong').textContent=strong; $('#dbObserve').textContent=observe; $('#dbDanger').textContent=danger;
  // AI gauge
  gauge('#aiGauge','#aiScore',ai);
  $('#aiTag').textContent = ai>=75?'市場偏多 · 可積極':ai>=55?'中性偏多 · 選股操作':ai>=40?'中性 · 謹慎':'偏空 · 保守觀望';
  $('#aiTag').style.color = ai>=55?'var(--green)':ai>=40?'var(--yellow)':'var(--red)';
  // 重點清單
  const tb=$('#dbTopTable tbody'); tb.innerHTML='';
  stocks.map(s=>({s,fr:fiveRules(s).score,bi:bottomIndex(s).score,ti:topIndex(s).score,st:statusOf(s),pe:persona(s)}))
    .sort((a,b)=>b.fr-a.fr).slice(0,8).forEach(r=>{
    const [lc]=lightOf(r.fr);
    const stTag=r.st==='strong'?'<span class="pill light-90">強勢</span>':r.st==='danger'?'<span class="pill light-0">危險</span>':'<span class="pill light-70">觀察</span>';
    tb.innerHTML+=`<tr><td>${r.s.code}</td><td>${r.s.name||'-'}</td><td><span class="persona">${r.pe.emoji}${r.pe.type}</span></td>
      <td><span class="pill ${lc}">${r.fr}</span></td><td>${r.bi}</td><td>${r.ti}</td><td>${stTag}</td></tr>`;
  });
  if(!stocks.length) tb.innerHTML='<tr><td colspan="7" class="muted">尚無資料，請至選股中心新增股票</td></tr>';
  drawCharts();
}
function gauge(gSel,nSel,v){
  const g=$(gSel); g.style.setProperty('--v',v);
  const col=v>=75?'var(--green)':v>=55?'var(--cyan)':v>=40?'var(--yellow)':'var(--red)';
  g.style.setProperty('--col',col); $(nSel).textContent=v;
}

/* ---- 圖表 ---- */
function drawCharts(){
  const sorted=trades.slice().sort((a,b)=>(a.sellDate||'').localeCompare(b.sellDate||''));
  let cum=0; const eqL=[],eqD=[];
  sorted.forEach(t=>{cum+=n(t.pnl);eqL.push(t.sellDate||'');eqD.push(Math.round(cum));});
  const mAgg={};
  sorted.forEach(t=>{const m=(t.sellDate||'').slice(0,7)||'未填';mAgg[m]=(mAgg[m]||0)+n(t.pnl);});
  const ts=tradeStats();
  const baseOpts=c=>({responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
    scales:{x:{ticks:{color:'#8a97b4',font:{size:10}},grid:{display:false}},y:{ticks:{color:'#8a97b4',font:{size:10}},grid:{color:'rgba(255,255,255,.05)'}}}});
  mk('chartEquity','line',{labels:eqL.length?eqL:['—'],datasets:[{data:eqD.length?eqD:[0],borderColor:'#16d39a',backgroundColor:'rgba(22,211,154,.12)',fill:true,tension:.3,pointRadius:2}]},baseOpts());
  mk('chartMonthly','bar',{labels:Object.keys(mAgg).length?Object.keys(mAgg):['—'],datasets:[{data:Object.values(mAgg).length?Object.values(mAgg):[0],backgroundColor:Object.values(mAgg).map(v=>v>=0?'#16d39a':'#ff5b6e')}]},baseOpts());
  mk('chartWin','doughnut',{labels:['獲利','虧損'],datasets:[{data:[ts.win,ts.loss],backgroundColor:['#16d39a','#ff5b6e'],borderWidth:0}]},{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#e8eefc'}}}});
  mk('chartStats','bar',{labels:['總獲利','總虧損','淨利','均獲利','均虧損'],datasets:[{data:[ts.grossProfit,ts.grossLoss,ts.net,ts.avgWin,ts.avgLoss],backgroundColor:['#16d39a','#ff5b6e','#4d7cff','#9be36b','#ff9f43']}]},baseOpts());
}
function mk(id,type,data,opts){const el=document.getElementById(id);if(!el)return;if(charts[id])charts[id].destroy();charts[id]=new Chart(el,{type,data,options:opts});}

/* ---- 選股中心 ---- */
function renderScreener(filter=''){
  const tb=$('#stockTable tbody'); tb.innerHTML='';
  const list=stocks.filter(s=>!filter|| (s.code+s.name+(s.industry||'')).toLowerCase().includes(filter.toLowerCase()));
  $('#stockEmpty').style.display=stocks.length?'none':'block';
  list.forEach(s=>{
    const fr=fiveRules(s).score,[lc,lt]=lightOf(fr),bi=bottomIndex(s).score,ti=topIndex(s).score,pe=persona(s);
    tb.innerHTML+=`<tr>
      <td>${s.code}</td><td class="l">${s.name||'-'}</td><td>${s.industry||'-'}</td>
      <td>${fmt(s.price)}</td><td>${fmt(s.volume)}</td><td>${fmt(s.ma5)}</td><td>${fmt(s.ma20)}</td>
      <td>${fmt(s.rsi)}</td><td>${fmt(s.k)}/${fmt(s.d)}</td><td class="${cls(n(s.foreign))}">${fmt(s.foreign)}</td>
      <td><span class="persona">${pe.emoji}${pe.type}</span></td>
      <td><span class="pill ${lc}">${fr} ${lt}</span></td><td>${bi}</td><td>${ti}</td>
      <td><button class="link" onclick="showCard('${s.id}')">卡</button> · <button class="link" onclick="editStock('${s.id}')">編輯</button> · <button class="link" onclick="delStock('${s.id}')">刪</button></td>
    </tr>`;
  });
}

/* ---- 進場 ---- */
function renderEntrySel(){fillSel('#entrySelect',stocks,'-- 選擇股池股票 --');}
function renderExitSel(){
  const sel=$('#exitSelect'); sel.innerHTML='<option value="">-- 選擇股池或持股 --</option>';
  if(stocks.length){const og=document.createElement('optgroup');og.label='股池';stocks.forEach(s=>og.innerHTML+=`<option value="s:${s.id}">${s.code} ${s.name||''}</option>`);sel.appendChild(og);}
  if(holds.length){const og=document.createElement('optgroup');og.label='持股';holds.forEach(h=>og.innerHTML+=`<option value="h:${h.id}">${h.code} ${h.name||''} (持)</option>`);sel.appendChild(og);}
}
function fillSel(sel,arr,ph){const e=$(sel);e.innerHTML=`<option value="">${ph}</option>`;arr.forEach(s=>e.innerHTML+=`<option value="${s.id}">${s.code} ${s.name||''}</option>`);}

function showEntry(id){
  const s=stocks.find(x=>x.id===id); const box=$('#entryResult');
  if(!s){box.innerHTML='';return;}
  const fr=fiveRules(s),[lc,lt]=lightOf(fr.score),bi=bottomIndex(s),tp=targetPrices(s),pe=persona(s);
  // 綜合進場判斷（整合 進場三階段 + 禁止進場 + 大盤濾網）
  const combo=Math.round(fr.score*0.5+bi.score*0.5);
  const forb=forbidEntry(s), zone=entryZone(s), mk=marketInfo();
  let kind,verd;
  if(forb.length){kind='stop';verd='⛔ 禁止進場';}
  else if(zone){kind=zone.z==='A'?'watch':'go';verd=(zone.z==='C'?'🚀 ':zone.z==='B'?'✅ ':'🧪 ')+zone.label;}
  else if(fr.score>=60||bi.score>=60){kind='watch';verd='⚠️ 觀察 · 等更明確訊號';}
  else {kind='stop';verd='⛔ 不建議進場';}
  const zoneHtml=(zone&&!forb.length)?`<div class="zone-bar"><span class="zone-pill zone-${zone.z}">${zone.z}區</span><span>${zone.desc}</span></div>`:'';
  const forbHtml=forb.length?`<div class="forbid-box">⛔ 觸發禁止進場條件：<ul>${forb.map(r=>`<li>${r}</li>`).join('')}</ul></div>`:'';
  box.innerHTML=`
  <div class="verdict ${kind}">
    <h2>${verd}</h2>
    <div class="muted">${s.code} ${s.name||''} · <span class="persona">${pe.emoji}${pe.type}</span> ${pe.desc} · 大盤：<b>${mk.state}</b></div>
    ${zoneHtml}${forbHtml}
    <div class="metric-row">
      <div class="metric"><div class="v"><span class="pill ${lc}">${fr.score}</span></div><div class="k">五鐵律 ${lt}</div></div>
      <div class="metric"><div class="v">${bi.score}</div><div class="k">抄底指數</div></div>
      <div class="metric"><div class="v">${combo}</div><div class="k">綜合進場分</div></div>
    </div>
  </div>
  <div class="grid g2">
    <div class="card glass"><h3>🧱 五鐵律檢核</h3><ul class="factor-list">
      ${fr.items.map(i=>`<li><span>${i.n}</span><span class="${i.ok?'tick':'cross'}">${i.ok?'✔ +20':'✘ 0'}</span></li>`).join('')}
    </ul></div>
    <div class="card glass"><h3>🩸 低點抄底分析</h3>
      <p class="muted">機率 <b style="color:var(--green)">${bi.prob}%</b> · 建議：<b>${bi.advice}</b> · 風險：${bi.risk}</p>
      <ul class="factor-list">${bi.factors.map(f=>`<li><span>${f.n}</span><span>${f.p}/${f.max}</span></li>`).join('')}</ul>
    </div>
  </div>
  <div class="card glass"><h3>🎯 AI 目標價（${tp.basis}）</h3>
    <div class="target-row">
      ${[['第一目標',tp.t1],['第二目標',tp.t2],['第三目標',tp.t3]].map(([k,v])=>`<div class="target"><div class="lvl">${k}</div><div class="p">${v.toFixed(2)}</div><div class="up">+${((v-tp.price)/tp.price*100).toFixed(1)}%</div></div>`).join('')}
    </div>
    <button class="btn full" onclick="toRiskFromStock('${s.id}')">→ 帶入停損計算機</button>
  </div>`;
}

function showExit(val){
  const box=$('#exitResult'); if(!val){box.innerHTML='';return;}
  const [t,id]=val.split(':'); let s;
  if(t==='s') s=stocks.find(x=>x.id===id);
  else {const h=holds.find(x=>x.id===id); s=h?{code:h.code,name:h.name,price:h.price,ma5:h.ma5,ma20:h.ma20,rsi:h.rsi,k:h.k,d:h.d,volume:h.volume,vol5:h.vol5,foreign:h.foreign,margin:h.margin}:null; s&&(s._hold=h);}
  if(!s){box.innerHTML='';return;}
  const ti=topIndex(s); const g=exitGrade(ti.score);
  let kind=g.cls;
  box.innerHTML=`
  <div class="verdict ${kind}">
    <h2>🚨 逃命指數 ${ti.score}</h2>
    <div class="muted">${s.code} ${s.name||''} · 出場風險：<b>${ti.risk}</b></div>
    <div class="metric-row">
      <div class="metric"><div class="v">${ti.score}</div><div class="k">逃命指數</div></div>
      <div class="metric"><div class="v">${g.g}</div><div class="k">出場分級</div></div>
      <div class="metric"><div class="v">${g.pct}%</div><div class="k">建議減碼比例</div></div>
    </div>
  </div>
  <div class="card glass"><h3>🔥 高點預警因子</h3>
    <ul class="factor-list">${ti.factors.map(f=>`<li><span>${f.n}</span><span class="${f.p>0?'cross':''}">${f.p}/${f.max}</span></li>`).join('')}</ul>
    <p class="muted">${ti.score>=80?'⛔ 訊號過熱，建議立即減碼或停利出場。':ti.score>=60?'⚠️ 多項過熱，分批減碼鎖定獲利。':ti.score>=40?'保持警覺，移動停利顧好。':'✅ 尚無明顯過熱，可續抱。'}</p>
  </div>`;
}

/* ---- 停損計算 ---- */
function calcRisk(){
  const buy=n($('#rkBuy').value),stop=n($('#rkStop').value)||8,target=n($('#rkTarget').value);
  const cap=n($('#rkCapital').value)||cfg.capital,riskPct=n($('#rkRisk').value)||cfg.risk;
  if(!buy){toast('請輸入買進價');return;}
  const stopPrice=buy*(1-stop/100), lossPerShare=buy-stopPrice;
  const riskAmt=cap*riskPct/100, lots=Math.max(0,Math.floor(riskAmt/(lossPerShare*1000)));
  const rr=target>buy?(target-buy)/lossPerShare:0;
  const maxLoss=lossPerShare*lots*1000;
  let verd,vc; if(stop>10){verd='⛔ 停損過寬，禁止進場';vc='stop';}
    else if(rr>=2){verd='✅ 風報比合理，可執行';vc='go';}
    else if(rr>=1){verd='⚠️ 風報比偏低，謹慎';vc='watch';}
    else {verd=target?'⛔ 風報比不足，不建議':'⚠️ 未填目標價';vc=target?'stop':'watch';}
  $('#rkOut').innerHTML=`<h3>計算結果</h3>
    <div class="verdict ${vc}" style="margin-bottom:10px"><h2 style="font-size:20px">${verd}</h2></div>
    <ul class="factor-list">
      <li><span>停損價</span><b>${stopPrice.toFixed(2)}</b></li>
      <li><span>每股風險</span><b>${lossPerShare.toFixed(2)}</b></li>
      <li><span>建議張數</span><b>${lots} 張</b></li>
      <li><span>最大虧損</span><b class="neg">${money(maxLoss)}</b></li>
      <li><span>投入成本</span><b>${money(buy*lots*1000)}</b></li>
      <li><span>風險報酬比</span><b>${rr?('1 : '+rr.toFixed(2)):'—'}</b></li>
    </ul>`;
}
function toRiskFromStock(id){const s=stocks.find(x=>x.id===id);if(!s)return;const tp=targetPrices(s);
  switchTab('risk');$('#rkBuy').value=s.price;$('#rkTarget').value=tp.t1.toFixed(2);$('#rkCapital').value=cfg.capital;$('#rkRisk').value=cfg.risk;calcRisk();}

/* ---- 持股 ---- */
function renderHoldings(){
  const tb=$('#holdTable tbody');tb.innerHTML='';$('#holdEmpty').style.display=holds.length?'none':'block';
  holds.forEach(h=>{
    const pnl=(n(h.price)-n(h.buy))*n(h.shares)*1000, roi=n(h.buy)?(n(h.price)-n(h.buy))/n(h.buy)*100:0;
    tb.innerHTML+=`<tr><td>${h.buyDate||'-'}</td><td>${h.code}</td><td class="l">${h.name||'-'}</td>
      <td>${fmt(h.buy)}</td><td>${fmt(h.shares)}</td><td>${fmt(h.stop)}</td><td>${fmt(h.target)}</td><td>${fmt(h.price)}</td>
      <td class="${cls(pnl)}">${money(pnl)}</td><td class="${cls(roi)}">${pct(roi)}</td>
      <td><button class="link" onclick="closeHold('${h.id}')">平倉</button> · <button class="link" onclick="editHold('${h.id}')">編輯</button> · <button class="link" onclick="delHold('${h.id}')">刪</button></td></tr>`;
  });
}

/* ---- 交易紀錄 ---- */
function renderTrades(){
  const tb=$('#tradeTable tbody');tb.innerHTML='';$('#tradeEmpty').style.display=trades.length?'none':'block';
  trades.slice().sort((a,b)=>(b.sellDate||'').localeCompare(a.sellDate||'')).forEach(t=>{
    const roi=n(t.buy)?(n(t.sell)-n(t.buy))/n(t.buy)*100:0;
    tb.innerHTML+=`<tr><td>${t.buyDate||'-'}</td><td>${t.sellDate||'-'}</td><td>${t.code} ${t.name||''}</td>
      <td>${fmt(t.buy)}</td><td>${fmt(t.sell)}</td><td>${fmt(t.shares)}</td>
      <td class="${cls(n(t.pnl))}">${money(n(t.pnl))}</td><td class="${cls(roi)}">${pct(roi)}</td>
      <td class="l">${t.reasonIn||'-'}</td><td class="l">${t.reasonOut||'-'}</td>
      <td><button class="link" onclick="editTrade('${t.id}')">編輯</button> · <button class="link" onclick="delTrade('${t.id}')">刪</button></td></tr>`;
  });
}

/* ---- 統計 ---- */
function renderStats(){
  const s=tradeStats();
  const items=[['總交易次數',s.total],['勝率',s.winRate.toFixed(1)+'%'],['總獲利',money(s.grossProfit)],['總虧損',money(s.grossLoss)],
    ['淨利潤',money(s.net)],['平均獲利',money(s.avgWin)],['平均虧損',money(s.avgLoss)],['最大獲利',money(s.maxWin)],
    ['最大虧損',money(s.maxLoss)],['最大連勝',s.maxWinStreak],['最大連敗',s.maxLossStreak],['獲利因子',s.grossLoss?Math.abs(s.grossProfit/s.grossLoss).toFixed(2):'—']];
  $('#statGrid').innerHTML=items.map(([k,v])=>`<div class="card glass kpi"><span class="kpi-label">${k}</span><span class="kpi-val" style="font-size:18px">${v}</span></div>`).join('');
}

/* ---- AI 教練 ---- */
const COACH_RULES=[
  {k:'stop',label:'我有嚴守停損',good:true},
  {k:'noChase',label:'我沒有追高買進',good:true},
  {k:'noAdd',label:'我沒有逆勢亂加碼',good:true},
  {k:'plan',label:'我依計畫進出場',good:true},
  {k:'sizing',label:'我控制好部位大小',good:true},
  {k:'record',label:'我有確實記錄交易',good:true},
];
function renderCoach(){
  const d=today(); const rec=coach[d]||{checks:{}};
  const cg=$('#coachChecks'); cg.innerHTML='';
  COACH_RULES.forEach(r=>{
    cg.innerHTML+=`<label class="check"><input type="checkbox" data-k="${r.k}" ${rec.checks[r.k]?'checked':''}> ${r.label}</label>`;
  });
  const checked=COACH_RULES.filter(r=>rec.checks[r.k]).length;
  const disc=Math.round(checked/COACH_RULES.length*100);
  // 結合近期交易表現
  const ts=tradeStats();
  const perf=ts.total?Math.min(100,Math.round(ts.winRate*0.6 + (ts.net>=0?40:10))):50;
  const score=Math.round(disc*0.7+perf*0.3);
  gauge('#coachGauge','#coachScore',score);
  $('#coachTag').textContent=score>=85?'A · 紀律優異':score>=70?'B · 穩定':score>=55?'C · 待加強':'D · 需檢討';
  $('#coachTag').style.color=score>=70?'var(--green)':score>=55?'var(--yellow)':'var(--red)';
  // 優缺點建議
  const good=COACH_RULES.filter(r=>rec.checks[r.k]).map(r=>r.label);
  const bad=COACH_RULES.filter(r=>!rec.checks[r.k]).map(r=>r.label.replace('我','尚未確認'));
  const tips=[];
  if(!rec.checks.stop)tips.push('停損是交易的生命線，下單前先寫好停損價。');
  if(!rec.checks.noChase)tips.push('避免追高，等回測均線或拉回再進場。');
  if(!rec.checks.noAdd)tips.push('只加碼獲利部位，不要向下攤平虧損。');
  if(ts.total&&ts.winRate<50)tips.push(`近期勝率 ${ts.winRate.toFixed(0)}%，檢視進場條件是否過鬆。`);
  if(ts.net<0)tips.push('整體淨損，先縮小部位、回到只做最高分(五鐵律≥80)標的。');
  if(!tips.length)tips.push('維持現有紀律，續用五鐵律＋抄底指數雙重過濾。');
  $('#coachCards').innerHTML=`
    <div class="coach-block good"><h4>✅ 今日優點</h4><ul>${(good.length?good:['—']).map(x=>`<li>• ${x}</li>`).join('')}</ul></div>
    <div class="coach-block bad"><h4>⚠️ 缺點 / 風險</h4><ul>${(bad.length?bad:['本日紀律滿分 🎉']).map(x=>`<li>• ${x}</li>`).join('')}</ul></div>
    <div class="coach-block tip"><h4>💡 改善建議</h4><ul>${tips.map(x=>`<li>• ${x}</li>`).join('')}</ul></div>`;

  /* ----- AI 教練 · 每日簡報（升級）----- */
  const mk=marketInfo();
  // 最大風險：持股中逃命指數最高者
  let bigRisk='目前無持股，無部位風險。';
  if(holds.length){
    let worst=null,wt=-1;
    holds.forEach(h=>{const t=topIndex(holdToStock(h)).score;if(t>wt){wt=t;worst=h;}});
    bigRisk = wt>=40 ? `${worst.code} ${worst.name||''}：逃命指數 ${wt}，建議「${exitGrade(wt).g}」` : '持股風險可控，無高逃命指數標的。';
  }
  if(holds.some(h=>n(h.stop)>0&&n(h.price)>0&&n(h.price)<=n(h.stop))) bigRisk='有持股已跌破停損價，這是今日最大風險，須優先處理。';
  // 今日評語
  const comment = score>=85?'紀律執行到位，維持系統化操作節奏。':score>=70?'整體穩定，仍有 1~2 項紀律待落實。':score>=55?'紀律出現鬆動，留意是否情緒化交易。':'今日紀律不及格，建議暫停加碼、回到計畫面重新檢視。';
  // 明日任務
  const tasks=[];
  if(mk.has&&mk.risk>70) tasks.push('大盤風險指數 >70：明日以減碼／觀望為主，不開新倉。');
  else if(mk.state==='空方') tasks.push('空方環境：明日只做 A 區小量試單，嚴控部位。');
  else tasks.push('開盤先看作戰室「可進場」清單，優先 AI 總分最高者。');
  if(holds.some(h=>n(h.stop)>0&&n(h.price)>0&&n(h.price)<=n(h.stop))) tasks.push('開盤先處理已觸及停損的持股。');
  tasks.push('每筆下單前先填停損價，確認風險報酬比 ≥ 1 : 1.5。');
  // 紀律提醒
  const remind = !rec.checks.stop?'⚠️ 你尚未確認嚴守停損 — 這是最高優先紀律。':!rec.checks.noChase?'⚠️ 注意追高，等拉回 20MA 再進場。':!rec.checks.noAdd?'⚠️ 不要向下攤平，只加碼獲利部位。':'守住停損與部位上限，讓系統幫你過濾雜訊。';
  $('#coachUpgrade').innerHTML=`<h3>📋 AI 教練 · 每日簡報</h3>
   <div class="grid g2">
     <div class="coach-block tip"><h4>🗣 今日交易評語</h4><ul><li>${comment}</li></ul></div>
     <div class="coach-block bad"><h4>⚠️ 最大風險</h4><ul><li>${bigRisk}</li></ul></div>
     <div class="coach-block good"><h4>🎯 明日任務</h4><ul>${tasks.map(t=>`<li>• ${t}</li>`).join('')}</ul></div>
     <div class="coach-block tip"><h4>🧭 紀律提醒</h4><ul><li>${remind}</li></ul></div>
   </div>`;
}

/* ===================================================================
   Modal 表單
   =================================================================== */
const mask=$('#modalMask'),box=$('#modalBox');
function openModal(html){box.innerHTML=html;mask.classList.add('show')}
function closeModal(){mask.classList.remove('show')}
mask.addEventListener('click',e=>{if(e.target===mask)closeModal()});
function field(l,id,v='',t='number',span=false){return `<div class="${span?'span2':''}"><label>${l}</label><input id="${id}" type="${t}" value="${v??''}"></div>`}

/* 股票表單 */
function stockForm(s){
  s=s||{};
  openModal(`<h3>${s.id?'編輯':'新增'}股票</h3>
  <div class="form-grid">
    <div><label>股票代號* <small class="muted">(輸入自動帶名稱)</small></label><input id="f_code" type="text" value="${s.code||''}" oninput="codeAutofill()" list="codeList" autocomplete="off"></div>${field('股票名稱','f_name',s.name,'text')}
    ${field('產業類別','f_industry',s.industry,'text')}${field('目前價格','f_price',s.price)}
    ${field('成交量(張)','f_volume',s.volume)}${field('5日均量(張)','f_vol5',s.vol5)}
    ${field('5日均線','f_ma5',s.ma5)}${field('10日均線','f_ma10',s.ma10)}
    ${field('20日均線','f_ma20',s.ma20)}${field('60日均線','f_ma60',s.ma60)}
    ${field('RSI','f_rsi',s.rsi)}${field('MACD','f_macd',s.macd)}
    ${field('K 值','f_k',s.k)}${field('D 值','f_d',s.d)}
    ${field('外資買賣超(張)','f_foreign',s.foreign)}${field('投信買賣超(張)','f_trust',s.trust)}
    ${field('融資增減(張)','f_margin',s.margin)}${field('前波支撐價','f_support',s.support)}
    ${field('波段前高','f_prevHigh',s.prevHigh)}${field('波段前低','f_prevLow',s.prevLow)}
    ${field('平台突破高度','f_platform',s.platform,'number',true)}
  </div>
  <div class="modal-foot"><button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveStock('${s.id||''}')">儲存</button></div>`);
}
function saveStock(id){
  const g=k=>$('#f_'+k).value;
  if(!g('code')){toast('請輸入股票代號');return;}
  const o={id:id||uid(),code:g('code'),name:g('name'),industry:g('industry'),price:g('price'),volume:g('volume'),vol5:g('vol5'),
    ma5:g('ma5'),ma10:g('ma10'),ma20:g('ma20'),ma60:g('ma60'),rsi:g('rsi'),macd:g('macd'),k:g('k'),d:g('d'),
    foreign:g('foreign'),trust:g('trust'),margin:g('margin'),support:g('support'),prevHigh:g('prevHigh'),prevLow:g('prevLow'),platform:g('platform')};
  if(id){const i=stocks.findIndex(x=>x.id===id);stocks[i]=o;}else stocks.push(o);
  save();closeModal();renderAll();toast('已儲存');
}
function editStock(id){stockForm(stocks.find(x=>x.id===id))}
function delStock(id){if(confirm('確定刪除此股票？')){stocks=stocks.filter(x=>x.id!==id);save();renderAll();toast('已刪除')}}

/* 代號 → 自動帶名稱/產業（用內建台股字典） */
function codeAutofill(){
  const el=$('#f_code'); if(!el||!window.TW_STOCKS)return;
  const d=TW_STOCKS[el.value.trim()]; if(!d)return;
  const nm=$('#f_name'), ind=$('#f_industry');
  if(nm&&!nm.value) nm.value=d.n;
  if(ind&&!ind.value) ind.value=d.i;
}
/* 由代號快速加入（搜尋建議用） */
function addByCode(code){const d=(window.TW_STOCKS&&TW_STOCKS[code])||{};stockForm({code,name:d.n||'',industry:d.i||''});}
/* 建立代號 datalist（表單自動完成） */
function buildCodeDatalist(){
  if(!window.TW_STOCKS||document.getElementById('codeList'))return;
  const dl=document.createElement('datalist');dl.id='codeList';
  dl.innerHTML=Object.keys(TW_STOCKS).map(c=>`<option value="${c}" label="${TW_STOCKS[c].n}">`).join('');
  document.body.appendChild(dl);
}
/* 搜尋建議：可一鍵加入尚未在股池的股票 */
function updateStockSuggest(q){
  const box=$('#stockSuggest'); if(!box)return;
  q=(q||'').trim();
  if(!q||!window.TW_STOCKS){box.innerHTML='';return;}
  const inPool=new Set(stocks.map(s=>s.code));
  const ql=q.toLowerCase();
  const matches=Object.keys(TW_STOCKS).filter(c=>!inPool.has(c)&&(c.startsWith(q)||TW_STOCKS[c].n.toLowerCase().includes(ql))).slice(0,8);
  box.innerHTML=matches.length?matches.map(c=>`<div class="suggest-item" onclick="addByCode('${c}')">＋ <b>${c}</b> ${TW_STOCKS[c].n} <span class="muted">${TW_STOCKS[c].i}</span></div>`).join(''):'';
}

/* 批量貼上匯入 */
const BULK_COLS=['code','name','industry','price','volume','vol5','ma5','ma10','ma20','ma60','rsi','macd','k','d','foreign','trust','margin','support','prevHigh','prevLow','platform'];
const BULK_HEAD='代號,名稱,產業,價格,成交量,5日均量,5MA,10MA,20MA,60MA,RSI,MACD,K,D,外資,投信,融資,前波支撐,前高,前低,平台高度';
function bulkStockForm(){
  openModal(`<h3>⇪ 批量匯入股票</h3>
  <p class="muted">每行一檔，欄位用 <b>逗號</b> 或 <b>Tab</b>（可直接從 Excel／Google 試算表整列複製貼上）分隔。<b>只有「代號」必填</b>，其餘可留空；同代號會自動更新。</p>
  <p class="muted" style="margin-top:6px">欄位順序：<br><code style="color:var(--cyan);font-size:12px">${BULK_HEAD}</code></p>
  <label>貼上資料</label>
  <textarea id="f_bulk" style="min-height:160px;font-family:monospace;font-size:12px" placeholder="2330,台積電,半導體,1050,32000,25000,1010,990,960,900,64,8,72,60,8500,1200,-300,980,1080,850,40
2317,鴻海,電子,210,45000,40000,205,200,195,185,60,2,58,52,3000,500,100,190,220,150,15"></textarea>
  <div class="modal-foot"><button class="btn" onclick="fillBulkSample()">填入範例</button><button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveBulkStocks()">匯入</button></div>`);
}
function fillBulkSample(){
  $('#f_bulk').value=`2330,台積電,半導體,1050,32000,25000,1010,990,960,900,64,8,72,60,8500,1200,-300,980,1080,850,40
2317,鴻海,電子,210,45000,40000,205,200,195,185,60,2,58,52,3000,500,100,190,220,150,15
2603,長榮,航運,205,88000,42000,198,190,185,178,81,3,88,80,-5200,-800,6500,188,215,150,20`;
}
function saveBulkStocks(){
  const raw=($('#f_bulk').value||'').trim();
  if(!raw){toast('請先貼上資料');return;}
  let added=0,updated=0,skipped=0;
  raw.split(/\r?\n/).forEach(line=>{
    if(!line.trim())return;
    const cells=line.split(/[\t,]/).map(c=>c.trim());
    if(cells[0]==='代號'||/代號/.test(cells[0]))return; // 跳過標題列
    const code=cells[0];
    if(!code){skipped++;return;}
    const o={}; BULK_COLS.forEach((k,i)=>{ if(cells[i]!==undefined&&cells[i]!=='') o[k]=cells[i]; });
    // 只填代號時，用內建字典自動補名稱/產業
    if(window.TW_STOCKS&&TW_STOCKS[code]){ if(!o.name)o.name=TW_STOCKS[code].n; if(!o.industry)o.industry=TW_STOCKS[code].i; }
    const idx=stocks.findIndex(x=>x.code===code);
    if(idx>=0){stocks[idx]={...stocks[idx],...o};updated++;}
    else{stocks.push({id:uid(),...o});added++;}
  });
  save();closeModal();renderAll();
  toast(`匯入完成：新增 ${added}、更新 ${updated}${skipped?`、略過 ${skipped}`:''}`);
}

/* 持股表單 */
function holdForm(h){
  h=h||{buyDate:today()};
  openModal(`<h3>${h.id?'編輯':'新增'}持股</h3>
  <div class="form-grid">
    ${field('買進日期','f_buyDate',h.buyDate,'date')}${field('股票代號*','f_code',h.code,'text')}
    ${field('股票名稱','f_name',h.name,'text')}${field('買進價格','f_buy',h.buy)}
    ${field('張數','f_shares',h.shares)}${field('停損價','f_stop',h.stop)}
    ${field('目標價','f_target',h.target)}${field('目前價格','f_price',h.price)}
    ${field('RSI','f_rsi',h.rsi)}${field('K 值','f_k',h.k)}
    ${field('20日均線','f_ma20',h.ma20)}${field('外資買賣超','f_foreign',h.foreign)}
  </div>
  <div class="modal-foot"><button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveHold('${h.id||''}')">儲存</button></div>`);
}
function saveHold(id){
  const g=k=>$('#f_'+k).value;
  if(!g('code')){toast('請輸入代號');return;}
  const o={id:id||uid(),buyDate:g('buyDate'),code:g('code'),name:g('name'),buy:g('buy'),shares:g('shares'),
    stop:g('stop'),target:g('target'),price:g('price'),rsi:g('rsi'),k:g('k'),ma20:g('ma20'),foreign:g('foreign')};
  if(id){const i=holds.findIndex(x=>x.id===id);holds[i]={...holds[i],...o};}else holds.push(o);
  save();closeModal();renderAll();toast('已儲存');
}
function editHold(id){holdForm(holds.find(x=>x.id===id))}
function delHold(id){if(confirm('確定刪除此持股？')){holds=holds.filter(x=>x.id!==id);save();renderAll();toast('已刪除')}}
function closeHold(id){
  const h=holds.find(x=>x.id===id);if(!h)return;
  openModal(`<h3>平倉 → 轉交易紀錄</h3>
  <div class="form-grid">
    ${field('賣出日期','f_sellDate',today(),'date')}${field('賣出價格','f_sell',h.price)}
    <div class="span2"><label>出場原因</label><textarea id="f_reasonOut"></textarea></div>
    <div class="span2"><label>檢討心得</label><textarea id="f_note"></textarea></div>
  </div>
  <div class="modal-foot"><button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="doCloseHold('${id}')">確認平倉</button></div>`);
}
function doCloseHold(id){
  const h=holds.find(x=>x.id===id);const sell=n($('#f_sell').value);
  const pnl=(sell-n(h.buy))*n(h.shares)*1000;
  trades.push({id:uid(),buyDate:h.buyDate,sellDate:$('#f_sellDate').value,code:h.code,name:h.name,buy:h.buy,sell:sell,
    shares:h.shares,pnl:pnl,reasonIn:h.reasonIn||'',reasonOut:$('#f_reasonOut').value,note:$('#f_note').value});
  holds=holds.filter(x=>x.id!==id);save();closeModal();renderAll();toast('已平倉並寫入交易紀錄');
}

/* 交易紀錄表單 */
function tradeForm(t){
  t=t||{buyDate:today(),sellDate:today()};
  openModal(`<h3>${t.id?'編輯':'新增'}交易紀錄</h3>
  <div class="form-grid">
    ${field('買進日期','f_buyDate',t.buyDate,'date')}${field('賣出日期','f_sellDate',t.sellDate,'date')}
    ${field('股票代號*','f_code',t.code,'text')}${field('股票名稱','f_name',t.name,'text')}
    ${field('買進價','f_buy',t.buy)}${field('賣出價','f_sell',t.sell)}
    ${field('張數','f_shares',t.shares)}${field('損益(留空自動計算)','f_pnl',t.pnl)}
    <div class="span2"><label>進場原因</label><textarea id="f_reasonIn">${t.reasonIn||''}</textarea></div>
    <div class="span2"><label>出場原因</label><textarea id="f_reasonOut">${t.reasonOut||''}</textarea></div>
    <div class="span2"><label>檢討心得</label><textarea id="f_note">${t.note||''}</textarea></div>
  </div>
  <div class="modal-foot"><button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveTrade('${t.id||''}')">儲存</button></div>`);
}
function saveTrade(id){
  const g=k=>$('#f_'+k).value;
  if(!g('code')){toast('請輸入代號');return;}
  let pnl=g('pnl');
  if(pnl===''||pnl===null) pnl=(n(g('sell'))-n(g('buy')))*n(g('shares'))*1000;
  const o={id:id||uid(),buyDate:g('buyDate'),sellDate:g('sellDate'),code:g('code'),name:g('name'),buy:g('buy'),sell:g('sell'),
    shares:g('shares'),pnl:n(pnl),reasonIn:g('reasonIn'),reasonOut:g('reasonOut'),note:g('note')};
  if(id){const i=trades.findIndex(x=>x.id===id);trades[i]=o;}else trades.push(o);
  save();closeModal();renderAll();toast('已儲存');
}
function editTrade(id){tradeForm(trades.find(x=>x.id===id))}
function delTrade(id){if(confirm('確定刪除此紀錄？')){trades=trades.filter(x=>x.id!==id);save();renderAll();toast('已刪除')}}

/* ===================================================================
   導覽 / 事件綁定
   =================================================================== */
function switchTab(tab){
  $$('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  $$('.tab').forEach(t=>t.classList.toggle('active',t.id===tab));
  if(tab==='dashboard'||tab==='stats')drawCharts();
  if(tab==='war')renderWar();
  if(tab==='coach')renderCoach();
  window.scrollTo({top:0,behavior:'smooth'});
}
$('#nav').addEventListener('click',e=>{const b=e.target.closest('.nav-btn');if(b)switchTab(b.dataset.tab)});

$('#editMarketBtn').onclick=()=>marketForm();
$('#importStockBtn').onclick=()=>bulkStockForm();
$('#addStockBtn').onclick=()=>stockForm();
$('#addHoldBtn').onclick=()=>holdForm();
$('#addTradeBtn').onclick=()=>tradeForm();
$('#stockSearch').oninput=e=>{renderScreener(e.target.value);updateStockSuggest(e.target.value);};
$('#entrySelect').onchange=e=>showEntry(e.target.value);
$('#exitSelect').onchange=e=>showExit(e.target.value);
$('#rkCalc').onclick=calcRisk;
$('#saveCapital').onclick=()=>{cfg.capital=n($('#accCapital').value)||cfg.capital;cfg.risk=n($('#accRisk').value)||cfg.risk;save();$('#capitalNote').textContent=`已儲存：總資金 ${money(cfg.capital)}，單筆風險 ${cfg.risk}%`;toast('資金設定已儲存')};
$('#coachSave').onclick=()=>{const d=today();const checks={};$$('#coachChecks input').forEach(i=>checks[i.dataset.k]=i.checked);coach[d]={checks};save();renderCoach();toast('今日自評已儲存')};

/* 匯出 / 匯入 */
$('#exportBtn').onclick=()=>{
  const data=JSON.stringify({stocks,holds,trades,cfg,coach},null,2);
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([data],{type:'application/json'}));
  a.download='台股AI買賣決策_'+today()+'.json';a.click();toast('已匯出 JSON');
};
$('#importBtn').onclick=()=>$('#importFile').click();
$('#importFile').onchange=e=>{
  const f=e.target.files[0];if(!f)return;const r=new FileReader();
  r.onload=()=>{try{const d=JSON.parse(r.result);
    stocks=d.stocks||[];holds=d.holds||[];trades=d.trades||[];cfg=d.cfg||cfg;coach=d.coach||{};
    save();renderAll();toast('匯入成功');}catch(err){toast('檔案格式錯誤')}};
  r.readAsText(f);
};

/* ---------- 首次示範資料 ---------- */
function seed(){
  if(stocks.length||localStorage.getItem('fj_seeded'))return;
  localStorage.setItem('fj_seeded','1');
  stocks=[
    {id:uid(),code:'2330',name:'台積電',industry:'半導體',price:1050,volume:32000,vol5:25000,ma5:1010,ma10:990,ma20:960,ma60:900,rsi:64,macd:8,k:72,d:60,foreign:8500,trust:1200,margin:-300,support:980,prevHigh:1080,prevLow:850,platform:40},
    {id:uid(),code:'2454',name:'聯發科',industry:'IC設計',price:1380,volume:9800,vol5:9000,ma5:1360,ma10:1350,ma20:1320,ma60:1280,rsi:58,macd:5,k:55,d:50,foreign:1200,trust:300,margin:200,support:1300,prevHigh:1450,prevLow:1180,platform:50},
    {id:uid(),code:'2603',name:'長榮',industry:'航運',price:205,volume:88000,vol5:42000,ma5:198,ma10:190,ma20:185,ma60:178,rsi:81,macd:3,k:88,d:80,foreign:-5200,trust:-800,margin:6500,support:188,prevHigh:215,prevLow:150,platform:20},
    {id:uid(),code:'2882',name:'國泰金',industry:'金融',price:62,volume:21000,vol5:20000,ma5:61.5,ma10:61,ma20:60.8,ma60:60,rsi:52,macd:0.2,k:50,d:48,foreign:300,trust:100,margin:-50,support:60,prevHigh:66,prevLow:55,platform:3},
    {id:uid(),code:'3034',name:'聯詠',industry:'IC設計',price:480,volume:6200,vol5:9000,ma5:495,ma10:505,ma20:520,ma60:540,rsi:32,macd:-4,k:22,d:30,foreign:-1500,trust:200,margin:-1200,support:470,prevHigh:600,prevLow:455,platform:15},
  ];
  cfg.market={twPrice:23000,twMa20:22500,twMa60:21800,otcPrice:255,otcMa20:250,otcMa60:240};
  save();
}

/* ---------- 啟動 ---------- */
seed();
buildCodeDatalist();
$('#accCapital').value=cfg.capital; $('#accRisk').value=cfg.risk;
renderAll();
