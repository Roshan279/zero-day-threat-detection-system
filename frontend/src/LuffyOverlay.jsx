import { useState, useEffect, useRef } from "react"
import PixelLuffy from "./px/PixelLuffy"
import PxIcon from "./px/PxIcon"
import { Btn } from "./px/ui"

const LUFFY_LINES = {
  idle:     ["Nothing feels wrong. I trust that.","The system is calm. I'm ready either way.","Boring is good. Boring means safe.","I don't need to understand everything to protect it."],
  alert:    ["Something moved that shouldn't have. I can tell.","Someone here is not who they say they are.","I'm paying attention now. Real attention."],
  thinking: ["Hmm. Give me a second.","This is the part where I figure it out. Usually.","Something about this doesn't add up. Let me look closer."],
  happy:    ["Everything is safe! That's all that matters.","All clear! I'll take it.","SHISHISHI!! Nothing bad happening!"],
  angry:    ["SOMEONE IS ATTACKING THIS SYSTEM. I WON'T ALLOW IT.","THIS IS NOT OKAY. FIX THIS. NOW.","Nobody messes with what's mine."],
  sleepy:   ["Zzz... I can't see the logs right now.","I can't reach the backend. Wake it up for me?"],
  goofy:    ["I solved it!! ...What did I solve exactly?","SHISHISHI! I had no plan and it still worked!","I don't know what happened but the bad stuff is gone!"],
}

// color: the tag color used on the speech bubble and the status tag
export const MOOD_CONFIG = {
  idle:     {color:"#4bc292",label:"MONITORING"},
  alert:    {color:"#ff9a00",label:"ON ALERT"  },
  thinking: {color:"#ffc83a",label:"THINKING"  },
  happy:    {color:"#4bc292",label:"ALL CLEAR" },
  angry:    {color:"#fe5f55",label:"CRITICAL"  },
  goofy:    {color:"#9b6bff",label:"CASE SOLVED"},
  sleepy:   {color:"#8a9a9a",label:"OFFLINE"   },
}

// Quick command suggestions shown above the input
const QUICK_COMMANDS = [
  { label:"Explain this event",    cmd:"explain this event"              },
  { label:"Show critical",         cmd:"show critical threats"           },
  { label:"Who is suspicious?",    cmd:"who is the most suspicious entity?" },
  { label:"Replay the attack",     cmd:"replay the attack"               },
  { label:"Run a scan",            cmd:"run a scan"                      },
  { label:"What can you do?",      cmd:"what can you do?"                },
]

function useTypewriter(text, speed=22) {
  const [displayed, setDisplayed] = useState("")
  useEffect(()=>{
    setDisplayed("")
    if(!text)return
    let i=0
    const interval=setInterval(()=>{
      setDisplayed(text.slice(0,i+1))
      i++
      if(i>=text.length){clearInterval(interval)}
    },speed)
    return()=>clearInterval(interval)
  },[text])
  return {displayed}
}

// ─────────────────────────────────────────────────────────────
// LUFFY: the mascot. dock.mode "full" puts the portrait at the bottom of the left panel;
// "avatar" shrinks him to a small badge when the window is short.
// ─────────────────────────────────────────────────────────────
export default function LuffyOverlay({ ariaState="idle", externalMessage=null, messageKey=0, dock={mode:"full",scale:4}, panelWidth=290, quiet=false, onCommand }) {
  const [minimized,    setMinimized]    = useState(false)
  const [currentLine,  setCurrentLine]  = useState("")
  const [showBubble,   setShowBubble]   = useState(false)
  const [bounce,       setBounce]       = useState(false)
  const [cmdInput,     setCmdInput]     = useState("")
  const [showCmdBox,   setShowCmdBox]   = useState(false)
  const [showHelp,     setShowHelp]     = useState(false)
  const inputRef = useRef(null)

  const ariaStateRef    = useRef(ariaState)
  useEffect(()=>{ ariaStateRef.current = ariaState },[ariaState])

  const {displayed} = useTypewriter(currentLine,20)

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

  // Context messages from the app. messageKey lets the same text be shown again.
  useEffect(()=>{
    if(!externalMessage)return
    const preview=externalMessage.length>160?externalMessage.slice(0,157)+"...":externalMessage
    triggerLine(ariaStateRef.current,preview)
    const st=ariaStateRef.current
    // Bubbles always fade so they never sit on top of page content for long
    const h=setTimeout(()=>setShowBubble(false),(st==="angry"||st==="alert")?16000:11000)
    return()=>clearTimeout(h)
  },[externalMessage,messageKey])

  useEffect(()=>{
    if(externalMessage)return
    triggerLine(ariaState)
    if(ariaState==="idle"||ariaState==="happy"){
      const t=setTimeout(()=>setShowBubble(false),9000)
      return()=>clearTimeout(t)
    }
  },[ariaState,externalMessage])

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

  const full = dock.mode === "full" && !minimized
  const spriteH = 42 * (dock.scale || 3)
  // Panels sit just above Luffy's head so they clear the cards at the bottom of the table
  const panelBottom = 100
  const panelLeft = panelWidth + 14
  const bubbleBottom = full ? spriteH + 100 : 92
  const bubbleLeft = full ? 14 : 90
  const bubbleWidth = full ? panelWidth - 28 : 300
  const tagText = cfg.label === "THINKING" ? "#1d2527" : "#fff"

  return (
    <>
      <div style={{position:"fixed",left:`${panelLeft}px`,bottom:`${panelBottom}px`,zIndex:1000,display:"flex",flexDirection:"column",alignItems:"flex-start",gap:"10px",pointerEvents:"none"}}>

        {showHelp && (
          <div className="pz-panel pz-bounce-in" style={{pointerEvents:"auto",padding:14,width:290}}>
            <div className="pz-title" style={{fontSize:23,marginBottom:8}}>WHAT I CAN DO</div>
            {[
              ["explain this event",    "Describe the focused card in plain English"],
              ["show critical threats", "Filter to high and critical cards"],
              ["who is suspicious?",    "Open the most suspicious entity"],
              ["replay the attack",     "Play the incident back step by step"],
              ["run a scan",            "Scan the logs right now"],
              ["block [name]",          "Block an account or IP"],
              ["go to [page]",          "Jump to any page by name"],
            ].map(([cmd,desc])=>(
              <button key={cmd} onClick={()=>handleCommand(cmd)} className="pz-inset" style={{display:"block",width:"100%",textAlign:"left",padding:"4px 8px",marginBottom:6,cursor:"pointer",color:"#fff",fontFamily:"var(--pxfont)"}}>
                <div style={{color:"var(--gold)",fontWeight:700,fontSize:19}}>{cmd}</div>
                <div style={{color:"#9fb4b2",fontSize:17}}>{desc}</div>
              </button>
            ))}
            <Btn color="gray" size="small" style={{width:"100%",marginTop:4}} onClick={()=>setShowHelp(false)}>Close</Btn>
          </div>
        )}

        {showCmdBox && (
          <div className="pz-panel pz-bounce-in" style={{pointerEvents:"auto",padding:14,width:340}}>
            <div className="pz-title" style={{fontSize:23,marginBottom:8}}>TELL LUFFY WHAT TO DO</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:10}}>
              {QUICK_COMMANDS.map(({label,cmd})=>(
                <Btn key={cmd} size="small" color="gray" onClick={()=>handleCommand(cmd)}>{label}</Btn>
              ))}
            </div>
            <div style={{display:"flex",gap:8}}>
              <input
                ref={inputRef}
                value={cmdInput}
                onChange={e=>setCmdInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="or type your own command..."
                aria-label="Command for Luffy"
                className="pz-inset"
                style={{flex:1,padding:"6px 10px",color:"#fff",fontFamily:"var(--pxfont)",fontSize:19,outline:"none",minWidth:0}}
              />
              <Btn color="blue" size="small" onClick={()=>handleCommand(cmdInput)}>Send</Btn>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginTop:10}}>
              <Btn size="small" color="gray" onClick={()=>setShowHelp(true)}>All commands</Btn>
              <Btn size="small" color="red" onClick={()=>setShowCmdBox(false)}>Close</Btn>
            </div>
          </div>
        )}

      </div>

      {showBubble && currentLine && !quiet && (
        <div style={{position:"fixed",left:bubbleLeft,bottom:bubbleBottom,width:bubbleWidth,zIndex:1001}}>
          <div className="pz-tip pz-bounce-in no-arrow" style={{pointerEvents:"auto",padding:"10px 36px 10px 14px"}}>
            <span className="pz-tag" style={{background:color,color:tagText,textShadow:cfg.label==="THINKING"?"none":undefined,marginBottom:4}}>{cfg.label}</span>
            <div style={{fontSize:20,lineHeight:1.2,fontWeight:500,minHeight:38}}>{displayed}</div>
            <button onClick={()=>setShowBubble(false)} aria-label="Close speech bubble" style={{position:"absolute",top:6,right:8,background:"none",border:0,cursor:"pointer",fontWeight:700,fontSize:20,color:"#4b5a58"}}>X</button>
            <span style={{position:"absolute",left:full?56:14,bottom:-15,width:0,height:0,borderLeft:"9px solid transparent",borderRight:"9px solid transparent",borderTop:"12px solid var(--ink)"}}/>
          </div>
        </div>
      )}

      {full ? (
        <div style={{position:"fixed",left:0,bottom:0,width:`${panelWidth}px`,zIndex:1000,display:"flex",flexDirection:"column",alignItems:"center",pointerEvents:"none",paddingBottom:12}}>
          <div style={{pointerEvents:"auto",position:"relative",display:"flex",flexDirection:"column",alignItems:"center",width:"100%"}}>
            <div style={{position:"absolute",top:0,left:12,display:"flex",flexDirection:"column",gap:6,zIndex:10}}>
              <button className="pz-btn gray small" style={{padding:"3px 6px"}} title="Make Luffy speak" aria-label="Make Luffy speak" onClick={()=>triggerLine(ariaState)}><PxIcon name="star" size={16}/></button>
              <button className="pz-btn gray small" style={{padding:"3px 6px"}} title="Give Luffy a command" aria-label="Give Luffy a command" onClick={()=>{setShowCmdBox(c=>!c);setShowHelp(false)}}><PxIcon name="chat" size={16}/></button>
            </div>
            <button className="pz-btn gray small" style={{position:"absolute",top:0,right:12,padding:"3px 8px",zIndex:10}} title="Minimize" aria-label="Minimize Luffy" onClick={()=>setMinimized(true)}>-</button>
            <div
              onClick={()=>triggerLine(ariaState)}
              style={{cursor:"pointer",userSelect:"none",marginTop:20,animation:bounce?"luffyBounce 0.5s ease":"none"}}
            >
              <PixelLuffy mood={ariaState} scale={dock.scale || 3}/>
            </div>
            <span className="pz-tag" style={{background:color,color:tagText,textShadow:cfg.label==="THINKING"?"none":undefined,marginTop:8,fontSize:17,padding:"2px 12px"}}>{cfg.label}</span>
          </div>
        </div>
      ) : (
        <button
          onClick={()=> minimized ? setMinimized(false) : (setShowCmdBox(c=>!c),setShowHelp(false))}
          title={minimized ? "Bring back Luffy" : "Talk to Luffy"}
          aria-label={minimized ? "Bring back Luffy" : "Talk to Luffy"}
          className="pz-panel"
          style={{position:"fixed",bottom:16,left:16,width:62,height:62,zIndex:1000,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",background:"#1b2829",boxShadow:`0 5px 0 var(--ink), 0 0 0 3px ${color}`,padding:0,overflow:"hidden"}}
        >
          <PixelLuffy mood={ariaState} view="head" height={42} animate={false}/>
        </button>
      )}
    </>
  )
}
