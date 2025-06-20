require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const fileUpload = require('express-fileupload');
const path = require('path');
const fs = require('fs');
const { OpenAI } = require('openai');
const Tesseract = require('tesseract.js');

const app = express();

// MongoDB Models
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
});
const historySchema = new mongoose.Schema({
  username: String,
  question: String,
  answer: String,
  createdAt: { type: Date, default: Date.now },
});
const User = mongoose.model('User', userSchema);
const History = mongoose.model('History', historySchema);

// OpenAI Setup
const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});
const HTTP_REFERER = process.env.HTTP_REFERER || "";

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());
app.use(
  session({
    secret: 'your_secret_key',
    resave: false,
    saveUninitialized: false,
  })
);

// Routes
app.get('/', (req, res) => res.redirect('index'));
app.get('/index', (req, res) => res.render('index'));
app.get('/entry', (req, res) => res.render('entry'));
app.get('/document', (req, res) => res.render('document'));
// Register
app.get('/register', (req, res) => res.render('register', { error: null }));
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = new User({ username, password });
    await user.save();
    req.session.username = username;
    res.redirect('/dashboard');
  } catch {
    res.render('register', { error: 'Username already taken' });
  }
});

// Login
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username, password });
  if (user) {
    req.session.username = username;
    res.redirect('/dashboard');
  } else {
    res.render('login', { error: 'Invalid username or password' });
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Dashboard (Ask question)
app.get('/dashboard', (req, res) => {
  if (!req.session.username) return res.redirect('/login');
  res.render('dashboard', {
    username: req.session.username,
    answer: null,
    error: null,
    messages: [],
  });
});

app.post('/dashboard', async (req, res) => {
  if (!req.session.username) return res.redirect('/login');
  const { question, exam, action } = req.body;

  if (!question) {
    return res.render('dashboard', {
      username: req.session.username,
      answer: null,
      error: 'Please enter a question.',
      messages: [{ category: 'error', message: 'Please enter a question.' }],
    });
  }

  let prompt = exam ? `This is a question from the ${exam}. ${question}` : question;
  switch (action) {
    case 'keywords': prompt += " Extract keywords."; break;
    case 'summarize': prompt += " Summarize this content."; break;
    case 'solution': prompt += " Give the solution."; break;
    case 'hint': prompt += " Give only a hint for the question."; break;
    case 'concept': prompt += " Explain the whole concept behind this."; break;
    case 'translate': prompt += " Translate this."; break;
    case 'questions': prompt += " Analyse the content and generate questions."; break;
    case 'tips': prompt += " Give tips to boost performance."; break;
    case 'shortnotes': prompt += " Give short notes of this content."; break;
  }

  try {
    const response = await client.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      extra_headers: {
        "HTTP-Referer": HTTP_REFERER,
        "X-Title": "ExamPro GPT",
      },
    });
    const answer = response.choices[0].message.content.trim();
    await History.create({ username: req.session.username, question, answer });

    res.render('dashboard', {
      username: req.session.username,
      answer,
      error: null,
      messages: [{ category: 'success', message: 'Answer generated successfully!' }],
    });
  } catch (err) {
    res.render('dashboard', {
      username: req.session.username,
      answer: null,
      error: 'OpenAI API error: ' + err.message,
      messages: [{ category: 'error', message: 'OpenAI API error: ' + err.message }],
    });
  }
});

// Upload Image (OCR)
app.post('/upload-doc', async (req, res) => {
  if (!req.session.username) return res.redirect('/login');
  if (!req.files || !req.files.image) {
    return res.render('dashboard', {
      username: req.session.username,
      answer: null,
      error: 'Please upload an image.',
      messages: [{ category: 'error', message: 'No image uploaded.' }],
    });
  }

  const img = req.files.image;
  const filePath = path.join(__dirname, 'temp', img.name);
  await img.mv(filePath);

  try {
    const { data: { text } } = await Tesseract.recognize(filePath, 'eng');
    fs.unlinkSync(filePath); // delete file

    const gptResponse = await client.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: text + "\nExplain this." }],
      extra_headers: {
        "HTTP-Referer": HTTP_REFERER,
        "X-Title": "ExamPro GPT",
      },
    });

    const answer = gptResponse.choices[0].message.content.trim();
    await History.create({ username: req.session.username, question: text, answer });

    res.render('dashboard', {
      username: req.session.username,
      answer,
      error: null,
      messages: [{ category: 'success', message: 'Image processed and question answered!' }],
    });
  } catch (err) {
    res.render('dashboard', {
      username: req.session.username,
      answer: null,
      error: 'OCR or GPT error: ' + err.message,
      messages: [{ category: 'error', message: 'OCR or GPT error: ' + err.message }],
    });
  }
});

// History View
app.get('/history', async (req, res) => {
  if (!req.session.username) return res.redirect('/login');
  const records = await History.find({ username: req.session.username })
    .sort({ createdAt: -1 })
    .limit(10);
  res.render('history', { records, username: req.session.username });
});

app.post('/delete_record/:id', async (req, res) => {
  if (!req.session.username) return res.redirect('/login');
  await History.deleteOne({ _id: req.params.id, username: req.session.username });
  res.redirect('/history');
});

app.post('/delete_all_history', async (req, res) => {
  if (!req.session.username) return res.redirect('/login');
  await History.deleteMany({ username: req.session.username });
  res.redirect('/history');
});

// Start Server
async function startServer() {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/examprogpt');
    console.log('✅ MongoDB Connected');
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err);
  }
}

startServer();
