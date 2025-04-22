require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const socketio = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { profile } = require('console');

const app = express();
const server = http.createServer(app);
const io = socketio(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/attendance_system', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB connected'))
  .catch(err => console.log(err));

// Schemas
const UserSchema = new mongoose.Schema({
  email: String,
  password: String,
  role: { type: String, enum: ['student', 'teacher'] },
  name: String,
  college: String,
  department: String,
  class: String,
  rollNumber: String,
  address: String,
  profileImage: String,
  idCardImage: String,
  timetableImage: String,
  createdAt: { type: Date, default: Date.now }
});

const SessionSchema = new mongoose.Schema({
  sessionId: String,
  teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  subject: String,
  location: {
    latitude: Number,
    longitude: Number
  },
  startTime: { type: Date, default: Date.now },
  endTime: Date,
  active: { type: Boolean, default: true }
});

const AttendanceSchema = new mongoose.Schema({
  sessionId: String,
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  studentName: String,
  rollNumber: String,
  location: {
    latitude: Number,
    longitude: Number
  },
  timestamp: { type: Date, default: Date.now },
  profileImage: String
});

const NoteSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  content: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Session = mongoose.model('Session', SessionSchema);
const Attendance = mongoose.model('Attendance', AttendanceSchema);
const Note = mongoose.model('Note', NoteSchema);

// Auth middleware
const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization').replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'attendance-secret');
    const user = await User.findOne({ _id: decoded._id });

    if (!user) throw new Error();
    req.token = token;
    req.user = user;
    next();
  } catch {
    res.status(401).send({ error: 'Please authenticate.' });
  }
};

// Routes
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, role, name, college, department, class: className, rollNumber, address, profileImage, idCardImage, timetableImage } = req.body;

    const existing = await User.findOne({ email });
    if (existing) return res.status(400).send({ error: 'Email already used' });

    const hashed = await bcrypt.hash(password, 8);
    const user = new User({
      email, password: hashed, role, name, college, department, class: className, rollNumber,
      address, profileImage, idCardImage, timetableImage
    });

    await user.save();
    const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET || 'attendance-secret');
    res.status(201).send({ user, token });
  } catch (e) {
    res.status(400).send(e);
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).send({ error: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).send({ error: 'Invalid credentials' });

    const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET || 'attendance-secret');
    res.send({ user, token });
  } catch (e) {
    res.status(400).send(e);
  }
});

app.get('/api/me', auth, async (req, res) => {
  const user = req.user.toObject();
  delete user.password;
  res.send(user);
});

app.post('/api/notes', auth, async (req, res) => {
  try {
    const note = new Note({ userId: req.user._id, content: req.body.content });
    await note.save();
    res.status(201).send(note);
  } catch (e) {
    res.status(400).send(e);
  }
});

app.get('/api/notes', auth, async (req, res) => {
  try {
    const notes = await Note.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.send(notes);
  } catch (e) {
    res.status(400).send(e);
  }
});

app.post('/api/student/mark-attendance', auth, async (req, res) => {
    try {
      const { sessionId, latitude, longitude } = req.body;
      const session = await Session.findOne({ sessionId, active: true });
      if (!session) return res.status(404).send({ error: 'Session not active' });
  
      const already = await Attendance.findOne({ sessionId, studentId: req.user._id });
      if (already) return res.status(400).send({ error: 'Already marked' });
  
      const attendance = new Attendance({
        sessionId,
        studentId: req.user._id,
        studentName: req.user.name,
        rollNumber: req.user.rollNumber,
        location: { latitude, longitude },
        profileImage: req.user.profileImage
      });
  
      await attendance.save();
      
      // Emit socket event
      io.to(sessionId).emit('attendance_marked', attendance);
      
      // Return session subject and date in response
      res.status(201).send({
        success: true,
        message: "Attendance marked",
        sessionId: session.sessionId,
        subject: session.subject,
        date: attendance.timestamp.toISOString(),
        attendance
      });
    } catch (e) {
      res.status(400).send(e);
    }
  });

  // // Update the attendance-history endpoint
  // app.get('/api/student/attendance-history', auth, async (req, res) => {
  //   try {
  //     console.log('Fetching attendance history for student:', req.user._id);
      
  //     // 1. Get student details
  //     const student = await User.findById(req.user._id);
  //     if (!student) {
  //       console.log('Student not found');
  //       return res.status(404).send({ error: 'Student not found' });
  //     }
  
  //     console.log(`Student department: ${student.department}, class: ${student.class}`);
  
  //     // 2. Find all sessions (both active and inactive)
  //     const sessions = await Session.find({
  //       $or: [
  //         { department: student.department },
  //         { class: student.class }
  //       ]
  //     }).sort({ startTime: -1 });
  
  //     console.log(`Found ${sessions.length} sessions`);
  
  //     // 3. Find all attendances for this student
  //     const attendances = await Attendance.find({ 
  //       studentId: req.user._id 
  //     });
  
  //     console.log(`Found ${attendances.length} attendances`);
  
  //     // 4. Create attendance map for quick lookup
  //     const attendanceMap = new Map();
  //     attendances.forEach(att => {
  //       attendanceMap.set(att.sessionId, att);
  //     });
  
  //     // 5. Build comprehensive history
  //     const history = sessions.map(session => {
  //       const attended = attendanceMap.has(session.sessionId);
  //       return {
  //         sessionId: session.sessionId,
  //         subject: session.subject,
  //         date: attended 
  //           ? attendanceMap.get(session.sessionId).timestamp 
  //           : session.startTime,
  //         status: attended ? "Present" : "Absent",
  //         location: session.location,
  //         teacherId: session.teacherId
  //       };
  //     });
  
  //     console.log(`Generated ${history.length} history items`);
  //     res.send(history);
  
  //   } catch (e) {
  //     console.error('Error in attendance-history:', e);
  //     res.status(500).send({ 
  //       error: "Failed to load attendance history",
  //       details: e.message,
  //       stack: e.stack 
  //     });
  //   }
  // });



// Update the attendance-history endpoint
app.get('/api/student/attendance-history', auth, async (req, res) => {
  try {
    // Get all sessions for the student's department/class
    const student = await User.findById(req.user._id);
    const sessions = await Session.find({
      active: false, // Only completed sessions
      // Add department/class filtering if needed
      // department: student.department,
      // class: student.class
    }).sort({ startTime: -1 });

    // Get all attendances for this student
    const attendances = await Attendance.find({ 
      studentId: req.user._id 
    });

    // Create a map of sessionId to attendance for quick lookup
    const attendanceMap = new Map();
    attendances.forEach(att => attendanceMap.set(att.sessionId, att));

    // Build the history with present/absent status
    const history = sessions.map(session => {
      const attendance = attendanceMap.get(session.sessionId);
      return {
        sessionId: session.sessionId,
        subject: session.subject,
        date: attendance ? attendance.timestamp : session.startTime,
        status: attendance ? "Present" : "Absent",
        location: session.location
      };
    });

    res.send(history);
  } catch (e) {
    console.error("Error fetching attendance history:", e);
    res.status(500).send({ error: "Failed to load attendance history" });
  }
});


app.post('/api/teacher/start-session', auth, async (req, res) => {
  try {
    const { subject, latitude, longitude } = req.body;
    const sessionId = uuidv4().substring(0, 6).toUpperCase();
    const session = new Session({
      sessionId,
      teacherId: req.user._id,
      subject,
      location: { latitude, longitude }
    });

    await session.save();
    res.status(201).send(session);
  } catch (e) {
    res.status(400).send(e);
  }
});

app.post('/api/teacher/end-session', auth, async (req, res) => {
  try {
    const session = await Session.findOneAndUpdate(
      { sessionId: req.body.sessionId, teacherId: req.user._id, active: true },
      { active: false, endTime: new Date() },
      { new: true }
    );
    if (!session) return res.status(404).send({ error: 'Session not found' });
    res.send(session);
  } catch (e) {
    res.status(400).send(e);
  }
});

app.get('/api/teacher/session-attendance/:sessionId', auth, async (req, res) => {
  try {
    const attendance = await Attendance.find({ sessionId: req.params.sessionId });
    res.send(attendance);
  } catch (e) {
    res.status(400).send(e);
  }
});

io.on('connection', (socket) => {
  socket.on('join_session', (sessionId) => {
    socket.join(sessionId);
  });
});

app.get('/', (req, res) => {
  res.send('Attendance API Running');
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
