import { useEffect, useState } from "react"
import axios from "axios"

const API = "http://localhost:8000"

const TIERS = {
  1:{color:"#4ade80",bg:"#0a1f0f",label:"LOW"},
  2:{color:"#facc15",bg:"#1a1400",label:"MEDIUM"},
  3:{color:"#fb923c",bg:"#1a0e00",label:"HIGH"},
  4:{color:"#f87171",bg:"#1a0505",label:"CRITICAL"},
}

const ACTION_ICONS = {
  1: "📋",
  2: "📣",
  3: "🔒",
  4: "🚨",
}

function RuleCard({ rule }) {
  const t = TIERS[rule.tier] || TIERS[1]
  return (
    <div style={{background:"#080808",border:`1.5px solid ${t.color}44`,borderRadius:"4px",padding:"14px 16px",boxShadow:`0 0 12px ${t.color}11`}}>
      <div style={{display:"flex",alignItems:"center",gap:"10px",marginBottom:"10px"}}>
        <span style={{fontSize:"1.2rem"}}>{ACTION_ICONS[rule.tier]}</span>
        <div>
          <div style={{color:t.color,fontSize:"0.8rem",fontWeight:"bold",fontFamily:"'Orbitron',monospace",textShadow:`0 0 8px ${t.color}88`}}>{rule.label}</div>
          <div style={{color:"#444",fontSize:"0.58rem"}}>{rule.spec_tier}</div>
        </div>
      </div>
      {[["ACTION",rule.action],["SYSTEM DOES",rule.system_action||"Record to forensic log only"],["ANALYST MUST",rule.analyst_action],["RESPONSE TIME",rule.latency],["AUTOMATION",rule.automation]].map(([lbl,val])=>(
        <div key={lbl} style={{marginBottom:"6px"}}>
          <div style={{color:"#333",fontSize:"0.54rem",letterSpacing:"0.12em"}}>{lbl}</div>
          <div style={{color:"#e8d5b0",fontSize:"0.66rem",lineHeight:"1.4"}}>{val}</div>
        </div>
      ))}
    </div>
  )
}

function ResponseRow({ item, index }) {
  const t    = TIERS[item.tier] || TIERS[1]
  const r    = item.response
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <div onClick={()=>setExpanded(e=>!e)} style={{display:"flex",alignItems:"center",gap:"10px",padding:"7px 14px",borderBottom:"1px solid #0d0d0d",background:item.is_demo?t.bg:(index%2===0?"#050508":"#080810"),borderLeft:`2px solid ${item.is_demo?t.color:t.color+"33"}`,cursor:"pointer",transition:"all 0.15s"}}
        onMouseEnter={e=>e.currentTarget.style.background=t.bg}
        onMouseLeave={e=>e.currentTarget.style.background=item.is_demo?t.bg:(index%2===0?"#050508":"#080810")}
      >
        <span style={{color:t.color,fontSize:"0.58rem",fontWeight:"bold",background:t.bg,border:`1px solid ${t.color}44`,padding:"1px 6px",borderRadius:"2px",minWidth:"64px",textAlign:"center"}}>{t.label}</span>
        <span style={{color:"#333",fontSize:"0.6rem",minWidth:"125px"}}>{item.timestamp}</span>
        <span style={{color:"#888",fontSize:"0.6rem",minWidth:"55px"}}>#{item.event_id||"?"}</span>
        <span style={{color:item.phase?"#f87171":"#222",fontSize:"0.58rem",flex:1}}>{item.phase||item.source||"—"}</span>
        <div style={{display:"flex",alignItems:"center",gap:"4px",minWidth:"50px"}}>
          <div style={{width:"32px",height:"3px",background:"#111",borderRadius:"2px",overflow:"hidden"}}>
            <div style={{width:`${item.anomaly_score}%`,height:"100%",background:t.color}}/>
          </div>
          <span style={{color:t.color,fontSize:"0.58rem"}}>{item.anomaly_score}%</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:"6px",minWidth:"190px",background:`${t.color}11`,border:`1px solid ${t.color}44`,borderRadius:"3px",padding:"3px 8px"}}>
          <span style={{fontSize:"0.75rem"}}>{ACTION_ICONS[item.tier]}</span>
          <span style={{color:t.color,fontSize:"0.62rem",fontWeight:"bold",fontFamily:"'Share Tech Mono',monospace"}}>{r.label}</span>
        </div>
        <span style={{color:"#333",fontSize:"0.6rem"}}>{expanded?"▲":"▼"}</span>
      </div>
      {expanded&&(
        <div style={{padding:"10px 14px 10px 24px",borderBottom:"1px solid #111",background:t.bg,borderLeft:`2px solid ${t.color}`,animation:"luffyFadeIn 0.2s ease"}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"12px",fontFamily:"'Share Tech Mono',monospace"}}>
            {[["SYSTEM ACTION",r.system_action||"Record to forensic log"],["ANALYST REQUIRED",r.analyst_action],["RESPONSE TIME",r.latency+" · "+r.automation]].map(([lbl,val])=>(
              <div key={lbl}>
                <div style={{color:"#333",fontSize:"0.54rem",letterSpacing:"0.12em",marginBottom:"3px"}}>{lbl}</div>
                <div style={{color:"#e8d5b0",fontSize:"0.66rem",lineHeight:"1.5"}}>{val}</div>
              </div>
            ))}
          </div>
          {item.phase&&<div style={{marginTop:"8px"}}><span style={{color:"#f87171",fontSize:"0.6rem"}}>Attack Phase: {item.phase}</span></div>}
        </div>
      )}
    </>
  )
}

export default function ResponseSimulation() {
  const [data,setData]       = useState(null)
  const [loading,setLoading] = useState(true)
  const [filter,setFilter]   = useState(0)
  useEffect(()=>{
    axios.get(`${API}/response-simulation`)
      .then(r=>{setData(r.data);setLoading(false)})
      .catch(()=>setLoading(false))
  },[])
  if (loading) return <div style={{color:"#333",textAlign:"center",padding:"40px",fontSize:"0.8rem"}}>Loading response simulation...</div>
  if (!data)   return <div style={{color:"#333",textAlign:"center",padding:"40px",fontSize:"0.8rem"}}>No data. Run a scan first.</div>
  const filtered=filter===0?data.simulated_responses:data.simulated_responses.filter(r=>r.tier===filter)
  return (
    <div className="tab-enter" style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
      <div style={{padding:"14px 16px",borderBottom:"1px solid #1a1a1a",flexShrink:0}}>
        <div style={{marginBottom:"10px"}}>
          <div style={{color:"#555",fontSize:"0.6rem",letterSpacing:"0.18em",marginBottom:"4px"}}>◈ LAYER 6A — ACTIVE MITIGATION STRATEGY (per original platform spec)</div>
          <div style={{color:"#333",fontSize:"0.62rem"}}>{data.spec_note}</div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:"8px"}}>
          {Object.values(data.response_rules).map(rule=><RuleCard key={rule.tier} rule={rule}/>)}
        </div>
      </div>
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"6px 14px",borderBottom:"1px solid #111",background:"rgba(8,8,8,0.98)",flexShrink:0}}>
          <span style={{color:"#555",fontSize:"0.6rem",letterSpacing:"0.15em"}}>SIMULATED RESPONSES — {filtered.length} EVENTS</span>
          <div style={{display:"flex",gap:"5px",alignItems:"center"}}>
            <span style={{color:"#222",fontSize:"0.54rem",marginRight:"2px"}}>FILTER:</span>
            {[[0,"ALL","#555"],[1,"LOW","#4ade80"],[2,"MEDIUM","#facc15"],[3,"HIGH","#fb923c"],[4,"CRITICAL","#f87171"]].map(([v,l,c])=>(
              <button key={v} onClick={()=>setFilter(v)} style={{padding:"3px 8px",borderRadius:"2px",background:filter===v?`${c}18`:"transparent",border:`1px solid ${filter===v?c:"#111"}`,color:filter===v?c:"#222",cursor:"pointer",fontSize:"0.56rem",fontFamily:"'Share Tech Mono',monospace",boxShadow:filter===v?`0 0 8px ${c}44`:"none"}}>{l}</button>
            ))}
          </div>
          <div style={{display:"flex",gap:"6px"}}>
            {[4,3,2,1].map(t=>{
              const count=data.tier_summary[t]||0
              if(!count)return null
              const tc=TIERS[t].color
              return <div key={t} style={{display:"flex",alignItems:"center",gap:"4px",background:`${tc}11`,border:`1px solid ${tc}44`,borderRadius:"3px",padding:"2px 8px"}}><span style={{color:tc,fontSize:"0.6rem",fontWeight:"bold"}}>{ACTION_ICONS[t]} {count}</span></div>
            })}
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:"10px",padding:"5px 14px",borderBottom:"1px solid #0d0d0d",background:"rgba(5,5,8,0.98)",color:"#222",fontSize:"0.56rem",letterSpacing:"0.15em",flexShrink:0}}>
          <span style={{minWidth:"64px"}}>TIER</span>
          <span style={{minWidth:"125px"}}>TIMESTAMP</span>
          <span style={{minWidth:"55px"}}>EVENT ID</span>
          <span style={{flex:1}}>PHASE / SOURCE</span>
          <span style={{minWidth:"50px"}}>SCORE</span>
          <span style={{minWidth:"190px"}}>RESPONSE ACTION</span>
          <span style={{width:"20px"}}/>
        </div>
        <div style={{flex:1,overflowY:"auto"}}>
          {filtered.length===0
            ?<div style={{color:"#222",textAlign:"center",padding:"40px",fontSize:"0.8rem"}}>No events match this filter.</div>
            :filtered.map((item,i)=><ResponseRow key={item.event_db_id} item={item} index={i}/>)
          }
        </div>
      </div>
    </div>
  )
}