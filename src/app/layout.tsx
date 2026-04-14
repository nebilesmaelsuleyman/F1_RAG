import './global.css'

export const metadata ={
    title:"Fgemini",
    description:"Fgemini is a powerful AI assistant designed to help you with a wide range of tasks, from answering questions and providing information to assisting with creative projects and problem-solving. With its advanced natural language processing capabilities, Fgemini can understand and respond to your queries in a conversational manner, making it an invaluable tool for both personal and professional use."
}

const RootLayout=({children})=>{
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  )
}
export default RootLayout