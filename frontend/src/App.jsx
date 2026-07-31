import { useState, useRef, useEffect } from "react";
import api from "./api";
import "./App.css";


function App() {

  const [message, setMessage] = useState("");
  const [chat, setChat] = useState([
    {
      role:"bot",
      text:"Hola 👋 Soy tu tutor PAES. Pregúntame sobre Matemática, Lenguaje, Ciencias o Historia."
    }
  ]);

  const [loading,setLoading] = useState(false);

  const chatEndRef = useRef(null);


  // Scroll automático
  useEffect(()=>{
    chatEndRef.current?.scrollIntoView({
      behavior:"smooth"
    });
  },[chat,loading]);



  const sendMessage = async()=>{

    if(!message.trim() || loading) return;


    const currentMessage = message;


    // limpiamos inmediatamente
    setMessage("");


    setChat(prev=>[
      ...prev,
      {
        role:"user",
        text:currentMessage
      }
    ]);


    setLoading(true);


    try{

      const res = await api.post("/chat",{
        message:currentMessage
      });


      setChat(prev=>[
        ...prev,
        {
          role:"bot",
          text:res.data.response
        }
      ]);


    }catch(error){

      setChat(prev=>[
        ...prev,
        {
          role:"bot",
          text:"❌ Ocurrió un error al conectar con la IA."
        }
      ]);

      console.error(error);

    }


    setLoading(false);

  };



  return (

    <div className="app">


      <header className="header">

        <h1>
          🤖 PAES Tutor
        </h1>

        <p>
          Tu asistente inteligente para preparar la PAES
        </p>

      </header>



      <main className="chat-container">


        <div className="messages">


          {
            chat.map((msg,index)=>(

              <div
                key={index}
                className={
                  `message ${msg.role}`
                }
              >

                <div className="bubble">

                  {msg.text}

                </div>

              </div>

            ))
          }



          {
            loading &&
            <div className="message bot">

              <div className="bubble typing">

                IA escribiendo
                <span>.</span>
                <span>.</span>
                <span>.</span>

              </div>

            </div>
          }



          <div ref={chatEndRef}/>


        </div>



        <div className="input-area">


          <textarea

            value={message}

            onChange={
              e=>setMessage(e.target.value)
            }


            placeholder="Escribe tu pregunta PAES..."

            onKeyDown={
              e=>{

                if(
                  e.key==="Enter" &&
                  !e.shiftKey
                ){

                  e.preventDefault();
                  sendMessage();

                }

              }
            }


          />



          <button
            onClick={sendMessage}
            disabled={loading}
          >

            {loading ? "..." : "Enviar"}

          </button>


        </div>



      </main>


    </div>

  );

}


export default App;