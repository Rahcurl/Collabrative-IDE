const app = require('express')()
const http = require('http')
const { Server } = require('socket.io')
const cors = require("cors")
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

app.use(cors())
app.use(require('express').json())

const server = http.createServer(app)

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
})

app.get('/', function (req, res) {
  res.send('Hello from the server!')
})

const socketID_to_Users_Map = {}
const roomID_to_Code_Map = {}

async function getUsersinRoom(roomId, io) {
  const socketList = await io.in(roomId).allSockets()
  const userslist = []
  socketList.forEach((each => {
    (each in socketID_to_Users_Map) && userslist.push(socketID_to_Users_Map[each].username)
  }))

  return userslist
}

async function updateUserslistAndCodeMap(io, socket, roomId) {
  socket.in(roomId).emit("member left", { username: socketID_to_Users_Map[socket.id].username })

  // update the user list
  delete socketID_to_Users_Map[socket.id]
  const userslist = await getUsersinRoom(roomId, io)
  socket.in(roomId).emit("updating client list", { userslist: userslist })

  userslist.length === 0 && delete roomID_to_Code_Map[roomId]
}

//Whenever someone connects this gets executed
io.on('connection', function (socket) {
  console.log('A user connected', socket.id)

  socket.on("when a user joins", async ({ roomId, username }) => {
    console.log("username: ", username)
    socketID_to_Users_Map[socket.id] = { username }
    socket.join(roomId)

    const userslist = await getUsersinRoom(roomId, io)

    // for other users, updating the client list
    socket.in(roomId).emit("updating client list", { userslist: userslist })

    // for this user, updating the client list
    io.to(socket.id).emit("updating client list", { userslist: userslist })

    // send the latest code changes to this user when joined to existing room
    if (roomId in roomID_to_Code_Map) {
      io.to(socket.id).emit("on language change", { languageUsed: roomID_to_Code_Map[roomId].languageUsed })
      io.to(socket.id).emit("on code change", { code: roomID_to_Code_Map[roomId].code })
    }

    // alerting other users in room that new user joined
    socket.in(roomId).emit("new member joined", {
      username
    })
  })

  // for other users in room to view the changes
  socket.on("update language", ({ roomId, languageUsed }) => {
    if (roomId in roomID_to_Code_Map) {
      roomID_to_Code_Map[roomId]['languageUsed'] = languageUsed
    } else {
      roomID_to_Code_Map[roomId] = { languageUsed }
    }
  })

  // for user editing the code to reflect on his/her screen
  socket.on("syncing the language", ({ roomId }) => {
    if (roomId in roomID_to_Code_Map) {
      socket.in(roomId).emit("on language change", { languageUsed: roomID_to_Code_Map[roomId].languageUsed })
    }
  })

  // for other users in room to view the changes
  socket.on("update code", ({ roomId, code }) => {
    if (roomId in roomID_to_Code_Map) {
      roomID_to_Code_Map[roomId]['code'] = code
    } else {
      roomID_to_Code_Map[roomId] = { code }
    }
  })

  // for user editing the code to reflect on his/her screen
  socket.on("syncing the code", ({ roomId }) => {
    if (roomId in roomID_to_Code_Map) {
      socket.in(roomId).emit("on code change", { code: roomID_to_Code_Map[roomId].code })
    }
  })

  socket.on("leave room", ({ roomId }) => {
    socket.leave(roomId)
    updateUserslistAndCodeMap(io, socket, roomId)
  })

  socket.on("disconnecting", (reason) => {
    socket.rooms.forEach(eachRoom => {
      if (eachRoom in roomID_to_Code_Map) {
        updateUserslistAndCodeMap(io, socket, eachRoom)
      }
    })
  })

  //Whenever someone disconnects this piece of code executed
  socket.on('disconnect', function () {
    console.log('A user disconnected')
  })
})

//you can store your port number in a dotenv file, fetch it from there and store it in PORT
//we have hard coded the port number here just for convenience
const PORT = process.env.PORT || 5000

server.listen(PORT, function () {
  console.log(`listening on port : ${PORT}`)
})

// Simple code execution endpoint (local use only). Supports `python` and `javascript`.
// WARNING: executing arbitrary code can be dangerous. This endpoint is intended
// for local development and demo only.
app.post('/run', async (req, res) => {
  const { language, code } = req.body || {}
  if (!language || !code) return res.status(400).json({ error: 'language and code are required' })

  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  let ext, cmd, args
  if (language === 'python') {
    ext = '.py'
    // choose a python executable available on the system
    const candidates = ['python', 'py', 'python3']
    const { spawnSync } = require('child_process')
    let found = null
    for (const c of candidates) {
      try {
        const check = spawnSync(c, ['--version'], { windowsHide: true })
        if (check.status === 0) { found = c; break }
      } catch (e) {
        // ignore
      }
    }
    if (!found) {
      return res.status(400).json({ error: 'python not found on PATH. Install Python or enable the App Execution Alias for python/py.' })
    }
    cmd = found
    args = []
  } else if (language === 'javascript' || language === 'js') {
    ext = '.js'
    cmd = 'node'
    args = []
  } else {
    return res.status(400).json({ error: 'language not supported' })
  }

  const tmpDir = os.tmpdir()
  const filePath = path.join(tmpDir, `collab-run-${id}${ext}`)
  try {
    await fs.promises.writeFile(filePath, code, { encoding: 'utf8' })
  } catch (err) {
    return res.status(500).json({ error: 'failed to write temp file', details: err.message })
  }

  const child = spawn(cmd, [...args, filePath], { windowsHide: true })
  let stdout = ''
  let stderr = ''
  let killed = false

  const timeoutMs = 5000
  const timer = setTimeout(() => {
    killed = true
    try { child.kill('SIGKILL') } catch (e) {}
  }, timeoutMs)

  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

  child.on('error', (err) => {
    clearTimeout(timer)
    fs.promises.unlink(filePath).catch(() => {})
    return res.status(500).json({ error: 'failed to spawn process', details: err.message })
  })

  child.on('close', (codeExit, signal) => {
    clearTimeout(timer)
    fs.promises.unlink(filePath).catch(() => {})
    return res.json({ stdout, stderr, exitCode: codeExit, signal, timedOut: killed })
  })
})
