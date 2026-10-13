import express from 'express';
import cors from 'cors';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import {
  assertManageBacPage,
  calculateFinalGrade,
  parseAuthenticityToken,
  parseClassData,
  parseClasses
} from './managebac-parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const userSessions = new Map();

const SESSION_TIMEOUT = 48 * 60 * 60 * 1000;

if (process.env.NODE_ENV !== 'production') {
  app.use(cors({
    origin: /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/,
    credentials: true
  }));
}

app.use(express.json());
app.use(cookieParser());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../dist')));
}

// UTILITY FUNCTIONS

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

function mergeCookies(...cookieGroups) {
  const cookies = new Map();
  cookieGroups.flat().filter(Boolean).forEach(cookie => {
    const pair = cookie.split(';')[0];
    const name = pair.slice(0, pair.indexOf('='));
    if (name) cookies.set(name, pair);
  });
  return [...cookies.values()].join('; ');
}

function isSessionValid(session) {
  if (!session) return false;
  return Date.now() - session.lastAccess < SESSION_TIMEOUT;
}

function getValidSession(sessionId, res = null) {
  const session = userSessions.get(sessionId);
  if (!session || !isSessionValid(session)) {
    if (session) userSessions.delete(sessionId);
    return null;
  }
  session.lastAccess = Date.now();
  
  // Refresh cookie
  if (res) {
    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: SESSION_TIMEOUT
    });
  }
  
  return session;
}

// DATA FETCHING

async function getAuthenticityToken() {
  const { data, headers } = await axios.get('https://opengate.managebac.com/login');
  const token = parseAuthenticityToken(data);
  if (!token) throw new Error('Could not find authenticity token');
  return { token, cookies: headers['set-cookie'] || [] };
}

async function fetchClassData(classId, sessionCookie) {
  const { data } = await axios.get(`https://opengate.managebac.com/student/classes/${classId}/core_tasks`, {
    headers: { Cookie: sessionCookie }
  });
  assertManageBacPage(data);
  return parseClassData(data, classId);
}

// API ROUTES

app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  try {
    const { token, cookies } = await getAuthenticityToken();
    
    const { data, headers, status } = await axios.post(
      'https://opengate.managebac.com/sessions',
      new URLSearchParams({ 
        authenticity_token: token, 
        login: username, 
        password, 
        remember_me: '0', 
        commit: 'Sign in' 
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': cookies.map(c => c.split(';')[0]).join('; ')
        },
        maxRedirects: 0,
        validateStatus: () => true
      }
    );
    
    if (data?.includes('Invalid login or password')) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    const sessionCookies = headers['set-cookie'];
    const location = headers.location || '';
    if (status < 300 || status >= 400 || /\/login(?:[/?#]|$)/.test(location) || !sessionCookies?.length) {
      return res.status(401).json({ error: 'Login failed' });
    }
    
    const sessionId = generateSessionId();
    
    userSessions.set(sessionId, {
      cookie: mergeCookies(cookies, sessionCookies),
      createdAt: Date.now(),
      lastAccess: Date.now()
    });
    
    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: SESSION_TIMEOUT
    });
    
    res.json({ success: true });
    
  } catch (error) {
    res.status(401).json({ error: 'Login failed - please check your credentials' });
  }
});

app.post('/api/logout', (req, res) => {
  const sessionId = req.cookies.sessionId;
  
  if (sessionId) {
    userSessions.delete(sessionId);
  }
  
  res.clearCookie('sessionId', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  });
  
  res.json({ success: true });
});

app.get('/api/classes', async (req, res) => {
  const sessionId = req.cookies.sessionId;
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required' });
  }
  
  const session = getValidSession(sessionId, res);
  if (!session) {
    return res.status(401).json({ error: 'Session expired or invalid' });
  }
  
  try {
    const { data } = await axios.get('https://opengate.managebac.com/student/classes/my', {
      headers: { 'Cookie': session.cookie }
    });
    
    assertManageBacPage(data);
    const classes = parseClasses(data);
    
    const classesWithGrades = await Promise.all(
      classes.map(async (cls) => {
        try {
          const { categories, tasks } = await fetchClassData(cls.id, session.cookie);
          
          const finalGrade = calculateFinalGrade(tasks, categories);
          
          return {
            ...cls,
            finalGrade
          };
        } catch (error) {
          console.error(`Failed to fetch grade for class ${cls.id}:`, error.message);
          return {
            ...cls,
            finalGrade: null
          };
        }
      })
    );
    
    res.json({ classes: classesWithGrades });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch classes' });
  }
});

app.get('/api/tasks/:classId', async (req, res) => {
  const sessionId = req.cookies.sessionId;
  const { classId } = req.params;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required' });
  }
  
  const session = getValidSession(sessionId, res);
  if (!session) {
    return res.status(401).json({ error: 'Session expired or invalid' });
  }
  
  if (!/^\d+$/.test(classId)) {
    return res.status(400).json({ error: 'Invalid class ID' });
  }

  try {
    const { categories, tasks } = await fetchClassData(classId, session.cookie);
    res.json({ tasks, categories });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

if (process.env.NODE_ENV === 'production') {
  app.use((req, res) => {
    res.sendFile(path.join(__dirname, '../dist/index.html'));
  });
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
