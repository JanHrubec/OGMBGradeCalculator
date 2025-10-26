import express from 'express';
import cors from 'cors';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const userSessions = new Map();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../dist')));
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

async function getAuthenticityToken() {
  const { data, headers } = await axios.get('https://opengate.managebac.com/login');
  const tokenMatch = data.match(/name="authenticity_token"\s+value="([^"]+)"/);
  if (!tokenMatch) throw new Error('Could not find authenticity token');
  return { token: tokenMatch[1], cookies: headers['set-cookie'] || [] };
}

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  try {
    const { token, cookies } = await getAuthenticityToken();
    
    const { data, headers } = await axios.post(
      'https://opengate.managebac.com/sessions',
      new URLSearchParams({ authenticity_token: token, login: username, password, remember_me: '0', commit: 'Sign in' }),
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
    
    userSessions.set(username, sessionCookies.map(c => c.split(';')[0]).join('; '));
    res.json({ success: true, sessionId: username });
    
  } catch (error) {
    res.status(401).json({ error: 'Login failed - please check your credentials' });
  }
});

app.get('/api/classes', async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required' });
  }
  
  const sessionCookie = userSessions.get(sessionId);
  if (!sessionCookie) {
    return res.status(401).json({ error: 'Session not found' });
  }
  
  try {
    const { data } = await axios.get('https://opengate.managebac.com/student/classes/my', {
      headers: { 'Cookie': sessionCookie }
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
    
    res.json({ classes });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch classes' });
  }
});

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

app.get('/api/tasks/:classId', async (req, res) => {
  const { sessionId } = req.query;
  const { classId } = req.params;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required' });
  }
  
  const sessionCookie = userSessions.get(sessionId);
  if (!sessionCookie) {
    return res.status(401).json({ error: 'Session not found' });
  }
  
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
      if (!nameMatch) throw new Error('There was no task name found: ' + taskBlock);
      const taskId = nameMatch[1];
      const name = decodeHtmlEntities(nameMatch[2].trim());
      
      const monthMatch = taskBlock.match(patterns.month);
      const dayMatch = taskBlock.match(patterns.day);
      const date = (monthMatch && dayMatch) 
        ? `${extractText(monthMatch)} ${extractText(dayMatch)}`
        : null;
      
      const labelsWithColor = [...taskBlock.matchAll(patterns.labelWithColor)];
      const category = labelsWithColor.length > 1 ? decodeHtmlEntities(labelsWithColor[1][2].trim()) : null;
      const categoryColor = labelsWithColor.length > 1 ? labelsWithColor[1][1] : null;
      
      const pointsStr = extractText(taskBlock.match(patterns.points));
      const grade = extractText(taskBlock.match(patterns.grade));
      const percentage = calculatePercentage(pointsStr);
      
      tasks.push({
        id: taskIndex++,
        taskId,
        classId,
        name,
        date,
        category,
        categoryColor,
        points: pointsStr,
        grade,
        percentage
      });
    }
    
    const categoryAverages = {};
    const categorizedTasks = {};
    const categoryColors = {};
    
    tasks.forEach(task => {
      const cat = task.category || 'Uncategorized';
      
      if (!categorizedTasks[cat]) {
        categorizedTasks[cat] = [];
      }
      categorizedTasks[cat].push(task);
      
      if (task.categoryColor && !categoryColors[cat]) {
        categoryColors[cat] = task.categoryColor;
      }
      
      if (task.percentage !== null) {
        if (!categoryAverages[cat]) {
          categoryAverages[cat] = { total: 0, count: 0 };
        }
        categoryAverages[cat].total += task.percentage;
        categoryAverages[cat].count += 1;
      }
    });
    
    const gradeAverages = Object.keys(categorizedTasks).map(category => ({
      category,
      color: categoryColors[category] || null,
      average: categoryAverages[category] 
        ? Math.round(categoryAverages[category].total / categoryAverages[category].count) 
        : null,
      tasks: categorizedTasks[category].map(t => ({
        name: t.name,
        date: t.date,
        percentage: t.percentage
      }))
    }));
    
    res.json({ tasks, gradeAverages });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// Serve Vue app for all other routes in production
if (process.env.NODE_ENV === 'production') {
  app.use((req, res) => {
    res.sendFile(path.join(__dirname, '../dist/index.html'));
  });
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
