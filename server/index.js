import express from 'express';
import cors from 'cors';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const userSessions = new Map();

const SESSION_TIMEOUT = 48 * 60 * 60 * 1000;

app.use(cors({
  origin: true,
  credentials: true
}));

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

function decodeHtmlEntities(text) {
  if (!text) return text;
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function extractText(match, groupIndex = 1) {
  return match ? decodeHtmlEntities(match[groupIndex].trim()) : null;
}

function calculatePercentage(pointsStr) {
  if (!pointsStr || !pointsStr.includes('/')) return null;
  
  const [earned, total] = pointsStr.split('/').map(part => 
    parseFloat(part.replace('pts', '').trim())
  );
  
  return (!isNaN(earned) && !isNaN(total) && total > 0) 
    ? Math.round((earned / total) * 100) 
    : null;
}

// DATA FETCHING

async function getAuthenticityToken() {
  const { data, headers } = await axios.get('https://opengate.managebac.com/login');
  const tokenMatch = data.match(/name="authenticity_token"\s+value="([^"]+)"/);
  if (!tokenMatch) throw new Error('Could not find authenticity token');
  return { token: tokenMatch[1], cookies: headers['set-cookie'] || [] };
}

async function fetchCategories(classId, sessionCookie) {
  try {
    const { data } = await axios.get(`https://opengate.managebac.com/student/classes/${classId}/units`, {
      headers: { 'Cookie': sessionCookie }
    });
    
    const categoryItemRegex = /<div class='list-item'>[\s\S]*?<div class='label' style='--f-label-bg:\s*(#[A-Fa-f0-9]{3,6});[^>]*>([^<]+)<\/div>[\s\S]*?<div class='cell'>(\d+)%<\/div>/g;
    
    const categories = [];
    let match;
    
    while ((match = categoryItemRegex.exec(data)) !== null) {
      categories.push({
        name: decodeHtmlEntities(match[2].trim()),
        weight: parseInt(match[3]),
        color: match[1]
      });
    }
    
    return categories;
  } catch (error) {
    console.error(`Failed to fetch categories for class ${classId}:`, error.message);
    return [];
  }
}

async function fetchTasks(classId, sessionCookie) {
  try {
    const { data } = await axios.get(`https://opengate.managebac.com/student/classes/${classId}/core_tasks`, {
      headers: { 'Cookie': sessionCookie }
    });
    
    const taskBlockRegex = /<div class='fusion-card-item short-assignment section flex flex-wrap'>([\s\S]*?)<\/div>\s*(?:<a class="btn btn-primary"[\s\S]*?<\/a>\s*)?<div class='assessment[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g;
    const patterns = {
      name: /<a href="\/student\/classes\/\d+\/core_tasks\/(\d+)">([^<]+)<\/a>/,
      month: /<div class="month">([^<]+)<\/div>/,
      day: /<div class="day">([^<]+)<\/div>/,
      labelWithColor: /<div class='label' style='--f-label-bg: (#[A-Fa-f0-9]{3,6})[^>]*>([^<]+)<\/div>/g,
      points: /<div class='points'>([^<]+)<\/div>/,
      grade: /<span class='grade[^>]*>([^<]+)<\/span>/
    };
    
    const tasks = [];
    let taskIndex = 0;
    let match;
    
    while ((match = taskBlockRegex.exec(data)) !== null) {
      const taskBlock = match[0];
      
      const nameMatch = taskBlock.match(patterns.name);
      if (!nameMatch) continue;
      
      const monthMatch = taskBlock.match(patterns.month);
      const dayMatch = taskBlock.match(patterns.day);
      const date = (monthMatch && dayMatch) 
        ? `${extractText(monthMatch)} ${extractText(dayMatch)}`
        : null;
      
      const labelsWithColor = [...taskBlock.matchAll(patterns.labelWithColor)];
      const category = labelsWithColor.length > 1 ? decodeHtmlEntities(labelsWithColor[1][2].trim()) : null;
      
      const pointsStr = extractText(taskBlock.match(patterns.points));
      
      tasks.push({
        id: taskIndex++,
        taskId: nameMatch[1],
        classId,
        name: decodeHtmlEntities(nameMatch[2].trim()),
        date,
        category,
        points: pointsStr,
        grade: extractText(taskBlock.match(patterns.grade)),
        percentage: calculatePercentage(pointsStr)
      });
    }
    
    return tasks;
  } catch (error) {
    console.error(`Failed to fetch tasks for class ${classId}:`, error.message);
    return [];
  }
}

// GRADE CALCULATION

function calculateFinalGrade(tasks, categories) {
  if (!categories.length || !tasks.length) return null;
  
  const categoryAverages = {};
  
  tasks.forEach(task => {
    if (!task.category || task.percentage === null) return;
    
    if (!categoryAverages[task.category]) {
      categoryAverages[task.category] = { total: 0, count: 0 };
    }
    categoryAverages[task.category].total += task.percentage;
    categoryAverages[task.category].count += 1;
  });
  
  let totalWeightedScore = 0;
  let totalWeight = 0;
  
  categories.forEach(category => {
    if (category.weight > 0 && categoryAverages[category.name]) {
      const avg = categoryAverages[category.name].total / categoryAverages[category.name].count;
      totalWeightedScore += avg * category.weight;
      totalWeight += category.weight;
    }
  });
  
  return totalWeight > 0 ? Math.round(totalWeightedScore / totalWeight) : null;
}

// API ROUTES

app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  try {
    const { token, cookies } = await getAuthenticityToken();
    
    const { data, headers } = await axios.post(
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
    if (!sessionCookies?.length) {
      return res.status(401).json({ error: 'Login failed' });
    }
    
    const sessionId = generateSessionId();
    
    userSessions.set(sessionId, {
      username: username,
      cookie: sessionCookies.map(c => c.split(';')[0]).join('; '),
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
    
    const classRegex = /id='ib_class_(\d+)'[\s\S]*?<a href="\/student\/classes\/\d+">([^<\n]+)/g;
    const classes = [];
    let match;
    
    while ((match = classRegex.exec(data)) !== null) {
      classes.push({
        id: match[1],
        name: decodeHtmlEntities(match[2].trim().replace(/\s+/g, ' '))
      });
    }
    
    const classesWithGrades = await Promise.all(
      classes.map(async (cls) => {
        try {
          const [categories, tasks] = await Promise.all([
            fetchCategories(cls.id, session.cookie),
            fetchTasks(cls.id, session.cookie)
          ]);
          
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
  
  try {
    const [categories, tasks] = await Promise.all([
      fetchCategories(classId, session.cookie),
      fetchTasks(classId, session.cookie)
    ]);
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
