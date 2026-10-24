import { main } from './app.ts'

// The entry point, and nothing else. Everything worth importing lives in app.ts, so a later
// module that needs a piece of the main process — task 2's IPC wiring, for one — can take it
// without importing the file whose evaluation starts the application.
main()
