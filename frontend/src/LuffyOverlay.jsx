import { useState, useEffect, useRef } from "react"

const LUFFY_IMAGES = {
  idle:     "/aria/idleluffy.png",
  alert:    "/aria/alertluffy.png",
  thinking: "/aria/thinkingluffy.png",
  happy:    "/aria/happyluffy.png",
  angry:    "/aria/angryluffy.png",
  goofy:    "/aria/goofyluffy.png",
}

const LUFFY_LINES = {
  idle:     ["Nothing feels wrong. I trust that.","The system is calm. I'm ready either way.","Boring is good. Boring means safe.","I don't need to understand everything to protect it."],
  alert:    ["Something moved that shouldn't have. I can tell.","Someone here is not who they say they are.","I'm not scared. But I'm paying attention now. Real attention."],
  thinking: ["Hmm. Give me a second.","This is the part where I figure it out. Usually.","Something about this doesn't add up. Let me look closer."],
  happy:    ["Everything is safe! That's all that matters.","All clear! I'll take it.","SHISHISHI!! Nothing bad happening!"],
  angry:    ["SOMEONE IS ATTACKING THIS SYSTEM. I WON'T ALLOW IT.","THIS IS NOT OKAY. FIX THIS. NOW.","Nobody messes with what's mine."],
  goofy:    ["I solved it!! ...What did I solve exactly?","SHISHISHI! I had no plan and it still worked!","I don't know what happened but the bad stuff is gone!"],
}

export const MOOD_CONFIG = {
  idle:     {color:"#4ade80",label:"MONITORING"},
  alert:    {color:"#fb923c",label:"ON ALERT"  },
  thinking: {color:"#facc15",label:"THINKING"  },
  happy:    {color:"#4ade80",label:"ALL CLEAR" },
  angry:    {color:"#f87171",label:"CRITICAL"  },
  goofy:    {color:"#a78bfa",label:"CASE SOLVED"},
}

// Quick command suggestions shown above the input
const QUICK_COMMANDS = [
  { label:"Explain this event",    cmd:"explain this event"              },
  { label:"Show critical threats", cmd:"show critical threats"           },
  { label:"Who is suspicious?",    cmd:"who is the most suspicious entity?" },
  { label:"Replay the attack",     cmd:"replay the attack"               },
  { label:"Run a scan",            cmd:"run a scan"                      },
  { label:"What can you do?",      cmd:"what can you do?"                },
]

function useTypewriter(text, speed=22) {
  const [displayed, setDisplayed] = useState("")
  const [done,      setDone]      = useState(false)
  useEffect(()=>{
    setDisplayed("")
    setDone(false)
    if(!text)return
    let i=0
    const interval=setInterval(()=>{
      setDisplayed(text.slice(0,i+1))
      i++
      if(i>=text.length){clearInterval(interval);setDone(true)}
    },speed)
    return()=>clearInterval(interval)
  },[text])
  return {displayed,done}
}

export default function LuffyOverlay({ ariaState="idle", externalMessage=null, onCommand }) {
  const [minimized,    setMinimized]    = useState(false)
  const [currentLine,  setCurrentLine]  = useState("")
  const [showBubble,   setShowBubble]   = useState(false)
  const [bounce,       setBounce]       = useState(false)
  const [cmdInput,     setCmdInput]     = useState("")
  const [showCmdBox,   setShowCmdBox]   = useState(false)
  const [showHelp,     setShowHelp]     = useState(false)
  const inputRef = useRef(null)

  const lastExternalRef = useRef(null)
  const ariaStateRef    = useRef(ariaState)
  useEffect(()=>{ ariaStateRef.current = ariaState },[ariaState])

  const {displayed,done} = useTypewriter(currentLine,20)

  const cfg   = MOOD_CONFIG[ariaState] || MOOD_CONFIG.idle
  const color = cfg.color

  const triggerLine = (state, overrideLine=null) => {
    const line = overrideLine || (() => {
      const lines = LUFFY_LINES[state]||LUFFY_LINES.idle
      return lines[Math.floor(Math.random()*lines.length)]
    })()
    setCurrentLine(line)
    setShowBubble(true)
    setBounce(true)
    setTimeout(()=>setBounce(false),600)
  }

  // Fix: externalMessage effect with stable ariaStateRef
  useEffect(()=>{
    if(!externalMessage)return
    if(externalMessage===lastExternalRef.current)return
    lastExternalRef.current=externalMessage
    const preview=externalMessage.length>160?externalMessage.slice(0,157)+"...":externalMessage
    triggerLine(ariaStateRef.current,preview)
  },[externalMessage])

  // Fix: ariaState effect with externalMessage in deps
  useEffect(()=>{
    if(externalMessage)return
    triggerLine(ariaState)
    if(ariaState==="idle"||ariaState==="happy"){
      const t=setTimeout(()=>setShowBubble(false),9000)
      return()=>clearTimeout(t)
    }
  },[ariaState,externalMessage])

  // Focus input when command box opens
  useEffect(()=>{
    if(showCmdBox) setTimeout(()=>inputRef.current?.focus(),50)
  },[showCmdBox])

  const handleCommand = (cmd) => {
    if(!cmd.trim())return
    setCmdInput("")
    setShowCmdBox(false)
    setShowHelp(false)
    onCommand && onCommand(cmd)
  }

  const handleKeyDown = e => {
    if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent.isComposing){
      e.preventDefault()
      handleCommand(cmdInput)
    }
    if(e.key==="Escape"){setShowCmdBox(false);setShowHelp(false)}
  }

  if(minimized) return (
    <div onClick={()=>setMinimized(false)} title="Bring back Luffy" style={{
      position:"fixed",bottom:"20px",right:"20px",width:"62px",height:"62px",
      borderRadius:"50%",background:"#111",border:`2px solid ${color}`,
      cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",
      zIndex:1000,overflow:"hidden",boxShadow:`0 0 16px ${color}44`,transition:"border-color 0.5s,box-shadow 0.5s"
    }}>
      <img src={LUFFY_IMAGES[ariaState]||LUFFY_IMAGES.idle} alt="Luffy" style={{width:"130%",height:"130%",objectFit:"cover",mixBlendMode:"screen"}}/>
    </div>
  )

  return (
    <div style={{position:"fixed",bottom:"0px",right:"24px",zIndex:1000,display:"flex",flexDirection:"column",alignItems:"flex-end",pointerEvents:"none"}}>

      {/* ── HELP PANEL ── */}
      {showHelp && (
        <div style={{
          pointerEvents:"auto",marginBottom:"6px",marginRight:"10px",
          background:"#0d0d0d",border:`1px solid ${color}`,borderRadius:"10px",
          padding:"14px 16px",width:"280px",animation:"luffyFadeIn 0.2s ease",
          fontFamily:"'Share Tech Mono',monospace",boxShadow:`0 4px 20px ${color}22`
        }}>
          <div style={{color,fontSize:"0.58rem",letterSpacing:"0.15em",marginBottom:"10px",fontWeight:"bold"}}>WHAT I CAN DO</div>
          {[
            ["explain this event",        "Describe the selected log in plain English"],
            ["show critical threats",     "Filter to only high/critical events"],
            ["who is suspicious?",        "Show the most suspicious entity"],
            ["replay the attack",         "Start the step-by-step attack replay"],
            ["run a scan",                "Trigger an immediate security scan"],
            ["block [name]",              "Flag and block a specific entity"],
            ["go to [tab]",               "Navigate to any tab by name"],
          ].map(([cmd,desc])=>(
            <div key={cmd} onClick={()=>handleCommand(cmd)} style={{
              marginBottom:"7px",cursor:"pointer",padding:"5px 8px",borderRadius:"4px",
              background:"#111",border:"1px solid #1a1a1a",transition:"border-color 0.15s"
            }}
              onMouseEnter={e=>e.currentTarget.style.borderColor=color}
              onMouseLeave={e=>e.currentTarget.style.borderColor="#1a1a1a"}
            >
              <div style={{color,fontSize:"0.62rem",marginBottom:"1px"}}>"{cmd}"</div>
              <div style={{color:"#444",fontSize:"0.56rem"}}>{desc}</div>
            </div>
          ))}
          <button onClick={()=>setShowHelp(false)} style={{
            marginTop:"8px",width:"100%",padding:"5px",background:"transparent",
            border:`1px solid ${color}33`,borderRadius:"4px",color:"#444",
            cursor:"pointer",fontSize:"0.6rem",fontFamily:"'Share Tech Mono',monospace"
          }}>Close</button>
        </div>
      )}

      {/* ── COMMAND INPUT BOX ── */}
      {showCmdBox && (
        <div style={{
          pointerEvents:"auto",marginBottom:"6px",marginRight:"10px",
          background:"#0d0d0d",border:`1.5px solid ${color}`,borderRadius:"10px",
          padding:"12px 14px",width:"320px",animation:"luffyFadeIn 0.2s ease",
          fontFamily:"'Share Tech Mono',monospace",boxShadow:`0 4px 20px ${color}33`
        }}>
          <div style={{color,fontSize:"0.58rem",letterSpacing:"0.15em",marginBottom:"8px"}}>TELL LUFFY WHAT TO DO</div>

          {/* Quick command buttons */}
          <div style={{display:"flex",flexWrap:"wrap",gap:"5px",marginBottom:"10px"}}>
            {QUICK_COMMANDS.map(({label,cmd})=>(
              <button key={cmd} onClick={()=>handleCommand(cmd)} style={{
                padding:"3px 9px",borderRadius:"20px",background:"#111",
                border:`1px solid ${color}44`,color:"#888",cursor:"pointer",
                fontSize:"0.56rem",fontFamily:"'Share Tech Mono',monospace",
                transition:"all 0.15s"
              }}
                onMouseEnter={e=>{e.currentTarget.style.borderColor=color;e.currentTarget.style.color=color}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor=color+"44";e.currentTarget.style.color="#888"}}
              >{label}</button>
            ))}
          </div>

          {/* Text input */}
          <div style={{display:"flex",gap:"6px"}}>
            <input
              ref={inputRef}
              value={cmdInput}
              onChange={e=>setCmdInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="or type your own command..."
              style={{
                flex:1,background:"#080808",border:`1px solid ${color}44`,
                borderRadius:"4px",padding:"7px 10px",color:"#e8d5b0",
                fontSize:"0.68rem",fontFamily:"'Share Tech Mono',monospace",
                outline:"none"
              }}
            />
            <button onClick={()=>handleCommand(cmdInput)} style={{
              padding:"7px 12px",borderRadius:"4px",background:color+"18",
              border:`1px solid ${color}`,color,cursor:"pointer",
              fontSize:"0.68rem",fontFamily:"'Share Tech Mono',monospace"
            }}>▶</button>
          </div>

          <div style={{display:"flex",justifyContent:"space-between",marginTop:"8px"}}>
            <button onClick={()=>setShowHelp(true)} style={{background:"transparent",border:"none",color:"#333",cursor:"pointer",fontSize:"0.58rem",fontFamily:"'Share Tech Mono',monospace"}}>
              📋 see all commands
            </button>
            <button onClick={()=>setShowCmdBox(false)} style={{background:"transparent",border:"none",color:"#333",cursor:"pointer",fontSize:"0.58rem",fontFamily:"'Share Tech Mono',monospace"}}>
              close ✕
            </button>
          </div>
        </div>
      )}

      {/* ── SPEECH BUBBLE ── */}
      {showBubble && currentLine && (
        <div style={{
          pointerEvents:"auto",maxWidth:"300px",marginBottom:"6px",marginRight:"30px",
          position:"relative",animation:"luffyFadeIn 0.3s ease"
        }}>
          <div style={{
            background:"#0d0d0d",border:`1.5px solid ${color}`,borderRadius:"14px",
            padding:"12px 34px 12px 14px",fontSize:"0.74rem",lineHeight:"1.65",
            color:"#e8d5b0",fontFamily:"'Share Tech Mono',monospace",
            boxShadow:`0 4px 24px ${color}22`
          }}>
            <div style={{color,fontSize:"0.58rem",letterSpacing:"0.18em",marginBottom:"5px",fontWeight:"bold"}}>
              LUFFY // {cfg.label}
            </div>
            {displayed}
            {!done&&<span style={{color,animation:"luffyBlink 0.6s infinite"}}>▌</span>}
            <button onClick={()=>setShowBubble(false)} style={{position:"absolute",top:"8px",right:"10px",background:"transparent",border:"none",color:"#333",cursor:"pointer",fontSize:"0.75rem"}}>✕</button>
          </div>
          {/* Tail */}
          <div style={{position:"absolute",bottom:"-9px",right:"50px",width:0,height:0,borderLeft:"9px solid transparent",borderRight:"9px solid transparent",borderTop:`9px solid ${color}`}}/>
        </div>
      )}

      {/* ── LUFFY IMAGE + CONTROLS ── */}
      <div style={{pointerEvents:"auto",position:"relative",display:"flex",flexDirection:"column",alignItems:"center"}}>
        {/* Minimize */}
        <button onClick={()=>setMinimized(true)} title="Minimize" style={{position:"absolute",top:"14px",right:"4px",background:"#111",border:"1px solid #2a2a2a",color:"#444",width:"22px",height:"22px",borderRadius:"50%",cursor:"pointer",fontSize:"0.65rem",display:"flex",alignItems:"center",justifyContent:"center",zIndex:10}}>−</button>

        {/* Speak */}
        <button onClick={()=>triggerLine(ariaState)} title="Make Luffy speak" style={{position:"absolute",top:"14px",left:"4px",background:"#111",border:`1px solid ${color}44`,color,width:"22px",height:"22px",borderRadius:"50%",cursor:"pointer",fontSize:"0.65rem",display:"flex",alignItems:"center",justifyContent:"center",zIndex:10}}>💬</button>

        {/* Command button — the main new feature */}
        <button
          onClick={()=>{setShowCmdBox(c=>!c);setShowHelp(false)}}
          title="Give Luffy a command"
          style={{
            position:"absolute",top:"40px",left:"4px",
            background:showCmdBox?color+"33":"#111",
            border:`1px solid ${color}`,color,
            width:"22px",height:"22px",borderRadius:"50%",
            cursor:"pointer",fontSize:"0.65rem",
            display:"flex",alignItems:"center",justifyContent:"center",
            zIndex:10,transition:"all 0.2s",
            boxShadow:showCmdBox?`0 0 10px ${color}66`:"none"
          }}
        >⌘</button>

        <img
          src={LUFFY_IMAGES[ariaState]||LUFFY_IMAGES.idle}
          alt="Detective Luffy"
          style={{
            height:"280px",width:"auto",mixBlendMode:"screen",
            filter:`drop-shadow(0 0 18px ${color}66)`,
            transition:"filter 0.6s ease",
            animation:bounce?"luffyBounce 0.5s ease":"luffyFloat 3s ease-in-out infinite",
            display:"block",userSelect:"none"
          }}
        />

        {/* Status badge */}
        <div style={{
          position:"absolute",bottom:"8px",
          background:`${color}18`,border:`1px solid ${color}44`,
          borderRadius:"20px",padding:"2px 10px",
          fontSize:"0.54rem",color,letterSpacing:"0.12em",
          fontFamily:"'Share Tech Mono',monospace",
          pointerEvents:"none"
        }}>{cfg.label}</div>
      </div>
    </div>
  )
}