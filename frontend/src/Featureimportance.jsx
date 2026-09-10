import { useEffect, useState } from "react"
import axios from "axios"
import {
  BarChart, Bar, Cell, XAxis, YAxis, Tooltip,
  ResponsiveContainer, RadarChart, Radar,
  PolarGrid, PolarAngleAxis, PolarRadiusAxis
} from "recharts"

const API = "http://localhost:8000"

const TIERS = {
  1:{color:"#4ade80",bg:"#0a1f0f",label:"LOW"},
  2:{color:"#facc15",bg:"#1a1400",label:"MEDIUM"},
  3:{color:"#fb923c",bg:"#1a0e00",label:"HIGH"},
  4:{color:"#f87171",bg:"#1a0505",label:"CRITICAL"},
}

const FEATURE_COLORS = {
  "hour_of_day":"#60a5fa","event_id_mod":"#fb923c",
  "log_source":"#4ade80","event_type_risk":"#f87171",
}
const CHART_STYLE={backgroundColor:"#0d0d0d",border:"1px solid #2a2a2a",borderRadius:"4px",color:"#e8d5b0",fontSize:"0.68rem",fontFamily:"'Share Tech Mono', monospace"}

function AggregatePanel({ aggregate }) {
  if (!aggregate?.length) return null
  const cd=aggregate.map(f=>({name:f.label,value:f.avg_pct,share:f.share_pct,full:f.feature}))
  const tick={fill:"#444",fontSize:"0.6rem"}
  return (
    <div style={{background:"#080808",border:"1px solid #1a1a1a",borderRadius:"4px",padding:"16px"}}>
      <div style={{color:"#555",fontSize:"0.6rem",letterSpacing:"0.18em",marginBottom:"12px",display:"flex",alignItems:"center",gap:"8px"}}>
        <span style={{color:"#fb923c"}}>◈</span> AGGREGATE FEATURE INFLUENCE (across top 30 anomalies)
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"16px"}}>
        <div>
          <div style={{color:"#333",fontSize:"0.58rem",marginBottom:"8px"}}>Avg % contribution per feature</div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={cd} layout="vertical">
              <XAxis type="number" domain={[0,100]} tick={tick} tickFormatter={v=>`${v}%`}/>
              <YAxis type="category" dataKey="name" width={110} tick={{fill:"#888",fontSize:"0.6rem",fontFamily:"'Share Tech Mono',monospace"}}/>
              <Tooltip contentStyle={CHART_STYLE} formatter={v=>`${v}%`}/>
              <Bar dataKey="value" radius={[0,3,3,0]}>
                {cd.map((d,i)=><Cell key={i} fill={FEATURE_COLORS[d.full]||"#888"}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div>
          <div style={{color:"#333",fontSize:"0.58rem",marginBottom:"8px"}}>Share of total anomaly signal</div>
          <ResponsiveContainer width="100%" height={180}>
            <RadarChart data={cd}>
              <PolarGrid stroke="#1a1a1a"/>
              <PolarAngleAxis dataKey="name" tick={{fill:"#555",fontSize:"0.58rem",fontFamily:"'Share Tech Mono',monospace"}}/>
              <PolarRadiusAxis angle={30} domain={[0,50]} tick={{fill:"#333",fontSize:"0.56rem"}}/>
              <Radar name="Signal %" dataKey="share" stroke="#fb923c" fill="#fb923c" fillOpacity={0.2}/>
              <Tooltip contentStyle={CHART_STYLE}/>
            </RadarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div style={{display:"flex",gap:"16px",marginTop:"10px",flexWrap:"wrap"}}>
        {aggregate.map(f=>(
          <div key={f.feature} style={{display:"flex",alignItems:"flex-start",gap:"6px",maxWidth:"48%"}}>
            <div style={{width:"8px",height:"8px",borderRadius:"2px",background:FEATURE_COLORS[f.feature]||"#888",flexShrink:0,marginTop:"3px"}}/>
            <div>
              <div style={{color:FEATURE_COLORS[f.feature]||"#888",fontSize:"0.62rem",fontWeight:"bold"}}>{f.label} — {f.avg_pct}%</div>
              <div style={{color:"#444",fontSize:"0.58rem",lineHeight:"1.4"}}>{f.description}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function EventFIRow({ ev, isSelected, onClick }) {
  const t=TIERS[ev.tier]||TIERS[1]
  const top=ev.features?.[0]
  return (
    <div onClick={onClick}
      style={{display:"flex",alignItems:"center",gap:"10px",padding:"7px 14px",borderBottom:"1px solid #0d0d0d",
        background:isSelected?t.bg:"transparent",borderLeft:`2px solid ${isSelected?t.color:t.color+"22"}`,
        cursor:"pointer",transition:"all 0.15s"}}
      onMouseEnter={e=>e.currentTarget.style.background=t.bg}
      onMouseLeave={e=>e.currentTarget.style.background=isSelected?t.bg:"transparent"}
    >
      <span style={{color:t.color,fontSize:"0.58rem",minWidth:"60px",fontWeight:"bold",background:t.bg,border:`1px solid ${t.color}44`,padding:"1px 6px",borderRadius:"2px",textAlign:"center"}}>{t.label}</span>
      <span style={{color:"#333",fontSize:"0.6rem",minWidth:"55px"}}>DB-{ev.event_db_id}</span>
      <span style={{color:"#c8b890",fontSize:"0.68rem",minWidth:"60px"}}>#{ev.event_id||"?"}</span>
      <span style={{color:"#444",fontSize:"0.58rem",flex:1}}>{ev.timestamp}</span>
      {top&&<span style={{color:FEATURE_COLORS[top.feature]||"#888",fontSize:"0.6rem",minWidth:"120px"}}>↑ {top.label}</span>}
      <div style={{display:"flex",alignItems:"center",gap:"4px",minWidth:"60px",justifyContent:"flex-end"}}>
        <div style={{width:"36px",height:"3px",background:"#111",borderRadius:"2px",overflow:"hidden"}}>
          <div style={{width:`${ev.anomaly_score}%`,height:"100%",background:t.color}}/>
        </div>
        <span style={{color:t.color,fontSize:"0.6rem"}}>{ev.anomaly_score}%</span>
      </div>
    </div>
  )
}

function EventFIDetail({ ev }) {
  if (!ev) return <div style={{color:"#1a1a1a",textAlign:"center",marginTop:"40px",fontSize:"0.72rem",lineHeight:"2"}}>Select an event<br/>to see what drove<br/>its anomaly score</div>
  const t=TIERS[ev.tier]||TIERS[1]
  const bd=ev.features?.map(f=>({name:f.label,value:f.pct,feature:f.feature}))||[]
  return (
    <div style={{fontFamily:"'Share Tech Mono', monospace"}}>
      <div style={{marginBottom:"14px"}}>
        <div style={{color:t.color,fontSize:"0.75rem",fontWeight:"bold",textShadow:`0 0 8px ${t.color}88`}}>Event #{ev.event_id||"?"} · DB-{ev.event_db_id}</div>
        <div style={{color:"#333",fontSize:"0.58rem",marginTop:"2px"}}>{ev.timestamp}</div>
        <div style={{display:"flex",alignItems:"center",gap:"8px",marginTop:"6px"}}>
          <span style={{color:t.color,fontSize:"0.7rem",fontFamily:"'Orbitron',monospace"}}>{ev.anomaly_score}%</span>
          <span style={{color:"#333",fontSize:"0.58rem"}}>anomaly score</span>
        </div>
      </div>
      <div style={{marginBottom:"14px"}}>
        <div style={{color:"#333",fontSize:"0.58rem",letterSpacing:"0.12em",marginBottom:"8px"}}>FEATURE CONTRIBUTIONS</div>
        <ResponsiveContainer width="100%" height={130}>
          <BarChart data={bd} layout="vertical">
            <XAxis type="number" domain={[0,100]} tick={{fill:"#333",fontSize:"0.56rem"}} tickFormatter={v=>`${v}%`}/>
            <YAxis type="category" dataKey="name" width={95} tick={{fill:"#666",fontSize:"0.56rem",fontFamily:"'Share Tech Mono',monospace"}}/>
            <Tooltip contentStyle={CHART_STYLE} formatter={v=>`${v.toFixed(1)}%`}/>
            <Bar dataKey="value" radius={[0,3,3,0]}>
              {bd.map((d,i)=><Cell key={i} fill={FEATURE_COLORS[d.feature]||"#888"}/>)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div style={{color:"#333",fontSize:"0.58rem",letterSpacing:"0.12em",marginBottom:"8px"}}>BREAKDOWN</div>
      {ev.features?.map((f,i)=>(
        <div key={i} style={{marginBottom:"10px"}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:"2px"}}>
            <span style={{color:FEATURE_COLORS[f.feature]||"#888",fontSize:"0.62rem",fontWeight:"bold"}}>{f.label}</span>
            <span style={{color:FEATURE_COLORS[f.feature]||"#888",fontSize:"0.65rem",fontFamily:"'Orbitron',monospace"}}>{f.pct.toFixed(1)}%</span>
          </div>
          <div style={{height:"3px",background:"#111",borderRadius:"2px",overflow:"hidden",marginBottom:"3px"}}>
            <div style={{width:`${f.pct}%`,height:"100%",background:FEATURE_COLORS[f.feature]||"#888"}}/>
          </div>
          <div style={{color:"#444",fontSize:"0.56rem",lineHeight:"1.4"}}>{f.description}</div>
          <div style={{color:"#222",fontSize:"0.54rem",marginTop:"1px"}}>Raw: {f.value.toFixed(2)}</div>
        </div>
      ))}
    </div>
  )
}

export default function FeatureImportance({ onAskLuffy }) {
  const [data,setData]=useState(null)
  const [loading,setLoading]=useState(true)
  const [selected,setSelected]=useState(null)
  useEffect(()=>{
    axios.get(`${API}/feature-importance`)
      .then(r=>{setData(r.data);setLoading(false)})
      .catch(()=>setLoading(false))
  },[])
  if (loading) return <div style={{color:"#333",textAlign:"center",padding:"40px",fontSize:"0.8rem"}}>Computing feature importance...</div>
  if (!data)   return <div style={{color:"#333",textAlign:"center",padding:"40px",fontSize:"0.8rem"}}>No data yet. Run a scan first.</div>
  return (
    <div className="tab-enter" style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
      <div style={{padding:"14px 16px",borderBottom:"1px solid #1a1a1a",flexShrink:0,overflowY:"auto",maxHeight:"340px"}}>
        <AggregatePanel aggregate={data.aggregate}/>
      </div>
      <div style={{display:"flex",flex:1,overflow:"hidden"}}>
        <div style={{flex:1,overflowY:"auto"}}>
          <div style={{display:"flex",gap:"10px",padding:"5px 14px",borderBottom:"1px solid #0d0d0d",background:"rgba(5,5,8,0.98)",color:"#222",fontSize:"0.56rem",letterSpacing:"0.15em",position:"sticky",top:0,zIndex:5}}>
            <span style={{minWidth:"60px"}}>TIER</span><span style={{minWidth:"55px"}}>DB-ID</span>
            <span style={{minWidth:"60px"}}>EVENT ID</span><span style={{flex:1}}>TIMESTAMP</span>
            <span style={{minWidth:"120px"}}>TOP DRIVER</span><span>SCORE</span>
          </div>
          {data.per_event.length===0
            ?<div style={{color:"#222",textAlign:"center",padding:"40px",fontSize:"0.8rem"}}>No feature data. Run a scan to generate importance scores.</div>
            :data.per_event.map(ev=>(
              <EventFIRow key={ev.event_db_id} ev={ev}
                isSelected={selected?.event_db_id===ev.event_db_id}
                onClick={()=>{setSelected(ev);if(onAskLuffy)onAskLuffy(ev)}}
              />
            ))
          }
        </div>
        <div style={{width:"260px",minWidth:"260px",background:"#080808",borderLeft:"1px solid #1a1a1a",padding:"16px",overflowY:"auto"}}>
          <div style={{color:"#333",fontSize:"0.58rem",letterSpacing:"0.15em",marginBottom:"10px"}}>EVENT DETAIL</div>
          <EventFIDetail ev={selected}/>
        </div>
      </div>
    </div>
  )
}