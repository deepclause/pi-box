/** Allow importing non-code assets as strings (Vite `?raw`). */
declare module '*?raw' {
  const content: string
  export default content
}
