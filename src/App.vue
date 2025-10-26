<script setup>
import { ref, onMounted } from 'vue'
import axios from 'axios'

const API_BASE_URL = import.meta.env.PROD ? '/api' : 'http://localhost:3001/api'

const username = ref('')
const password = ref('')
const isLoading = ref(false)
const error = ref('')
const sessionId = ref(null)
const classes = ref([])
const currentView = ref('classes')
const selectedClass = ref(null)
const tasks = ref([])
const gradeAverages = ref([])
const originalGradeAverages = ref([])
const currentTab = ref('tasks')

// TEMPORARY
const categoryWeights = ref({})

// TEMPORARY
const loadCategoryWeights = (classId) => {
  const stored = localStorage.getItem(`categoryWeights_${classId}`)
  if (stored) {
    categoryWeights.value = JSON.parse(stored)
  } else {
    categoryWeights.value = {}
  }
}

// TEMPORARY
const saveCategoryWeights = (classId) => {
  localStorage.setItem(`categoryWeights_${classId}`, JSON.stringify(categoryWeights.value))
}

// TEMPORARY
const updateCategoryWeight = (category, value) => {
  const numValue = value === '' ? 0 : parseFloat(value)
  if (!isNaN(numValue) && numValue >= 0 && numValue <= 100) {
    categoryWeights.value[category] = numValue
    saveCategoryWeights(selectedClass.value.id)
  }
}

// TEMPORARY
const getCategoryWeight = (category) => {
  return categoryWeights.value[category] || 0
}

const calculateTotalClassAverage = () => {
  const categoriesWithAverages = gradeAverages.value.filter(cat => cat.average !== null)
  if (categoriesWithAverages.length === 0) return null
  
  let totalWeightedScore = 0
  let totalWeight = 0
  
  categoriesWithAverages.forEach(category => {
    const weight = getCategoryWeight(category.category)
    if (weight > 0 && category.average !== null) {
      totalWeightedScore += (category.average * weight)
      totalWeight += weight
    }
  })
  
  return totalWeight > 0 ? Math.round((totalWeightedScore / totalWeight)) : null
}

const calculateCategoryAverage = (tasks) => {
  const validTasks = tasks.filter(t => t.percentage !== null && t.percentage !== undefined)
  if (validTasks.length === 0) return null
  const total = validTasks.reduce((sum, task) => sum + task.percentage, 0)
  return Math.round(total / validTasks.length)
}

const isTaskModified = (categoryIndex, taskIndex) => {
  if (!originalGradeAverages.value[categoryIndex]) return false
  const original = originalGradeAverages.value[categoryIndex].tasks[taskIndex]
  const current = gradeAverages.value[categoryIndex].tasks[taskIndex]
  return original.percentage !== current.percentage
}

const restoreOriginalValue = (categoryIndex, taskIndex) => {
  const original = originalGradeAverages.value[categoryIndex].tasks[taskIndex]
  gradeAverages.value[categoryIndex].tasks[taskIndex].percentage = original.percentage
  gradeAverages.value[categoryIndex].average = calculateCategoryAverage(
    gradeAverages.value[categoryIndex].tasks
  )
}

const updatePercentage = (categoryIndex, taskIndex, value) => {
  const numValue = value === '' ? null : parseInt(value)
  if (numValue !== null && (isNaN(numValue) || numValue < 0 || numValue > 100)) {
    return
  }
  gradeAverages.value[categoryIndex].tasks[taskIndex].percentage = numValue
  gradeAverages.value[categoryIndex].average = calculateCategoryAverage(
    gradeAverages.value[categoryIndex].tasks
  )
}

const openTask = (task) => {
  if (task.taskId && task.classId) {
    const url = `https://opengate.managebac.com/student/classes/${task.classId}/core_tasks/${task.taskId}`
    window.open(url, '_blank')
  }
}

const parseTaskDate = (dateStr) => {
  const months = {
    'jan': 0,
    'feb': 1,
    'mar': 2,
    'apr': 3,
    'may': 4,
    'jun': 5,
    'jul': 6,
    'aug': 7,
    'sep': 8,
    'oct': 9,
    'nov': 10,
    'dec': 11
  }
  
  const parts = dateStr.toLowerCase().split(' ')
  
  const monthName = parts[0]
  const day = parseInt(parts[1])
  const month = months[monthName]
  
  const currentDate = new Date()
  const currentYear = currentDate.getFullYear()
  const currentMonth = currentDate.getMonth()

  // If the task is after August and it is currently before July assume it was for last year
  const year = (month > 7 && currentMonth < 6) ? currentYear - 1 : currentYear

  return new Date(year, month, day)
}

const handleLogin = async () => {
  if (!username.value || !password.value) {
    error.value = 'Please enter both username and password'
    return
  }

  isLoading.value = true
  error.value = ''

  try {
    const { data } = await axios.post(`${API_BASE_URL}/login`, {
      username: username.value,
      password: password.value
    })

    if (data.success) {
      sessionId.value = data.sessionId
      localStorage.setItem('sessionId', data.sessionId)
      await fetchClasses()
    }
  } catch (err) {
    error.value = err.response?.data?.error || 'Login failed. Please check your credentials.'
  } finally {
    isLoading.value = false
  }
}

const fetchClasses = async () => {
  isLoading.value = true
  try {
    const { data } = await axios.get(`${API_BASE_URL}/classes`, {
      params: { sessionId: sessionId.value }
    })
    classes.value = data.classes
  } catch (err) {
    error.value = 'Failed to fetch classes'
    if (err.response?.status === 401) {
      logout()
    }
  } finally {
    isLoading.value = false
  }
}

const fetchTasks = async (classId) => {
  isLoading.value = true
  error.value = ''
  try {
    const { data } = await axios.get(`${API_BASE_URL}/tasks/${classId}`, {
      params: { sessionId: sessionId.value }
    })
    // Sort tasks by date
    tasks.value = data.tasks.sort((a, b) => {
      const dateA = parseTaskDate(a.date)
      const dateB = parseTaskDate(b.date)
      return dateB - dateA
    })
    gradeAverages.value = data.gradeAverages
    // Deep copy for original values
    originalGradeAverages.value = JSON.parse(JSON.stringify(data.gradeAverages))
    // TEMPORARY
    loadCategoryWeights(classId)
  } catch (err) {
    error.value = 'Failed to fetch tasks'
    if (err.response?.status === 401) {
      logout()
    }
  } finally {
    isLoading.value = false
  }
}

const openClass = async (cls) => {
  selectedClass.value = cls
  currentView.value = 'tasks'
  await fetchTasks(cls.id)
}

const backToClasses = () => {
  currentView.value = 'classes'
  selectedClass.value = null
  tasks.value = []
  gradeAverages.value = []
  originalGradeAverages.value = []
  currentTab.value = 'tasks'
  error.value = ''
}

const logout = () => {
  username.value = ''
  password.value = ''
  sessionId.value = null
  classes.value = []
  tasks.value = []
  gradeAverages.value = []
  originalGradeAverages.value = []
  currentTab.value = 'tasks'
  currentView.value = 'classes'
  selectedClass.value = null
  error.value = ''
  localStorage.removeItem('sessionId')
}

onMounted(async () => {
  const savedSessionId = localStorage.getItem('sessionId')
  if (savedSessionId) {
    sessionId.value = savedSessionId
    await fetchClasses()
  }
})
</script>

<template>
  <div class="max-w-3xl mx-auto px-8 py-8 font-sans">
    <div class="text-center mb-8">
      <h1 class="text-gray-800 text-4xl m-0">ManageBac Grades Viewer</h1>
    </div>

    <!-- Login Form -->
    <div v-if="!sessionId" class="flex justify-center items-center min-h-[400px]">
      <div class="bg-white p-8 rounded-xl shadow-lg w-full max-w-md">
        <h2 class="mt-0 text-gray-800 text-center text-2xl mb-6">Sign Into ManageBac</h2>
        
        <form @submit.prevent="handleLogin">
          <div class="mb-6">
            <label for="username" class="block mb-2 text-gray-600 font-medium">Username</label>
            <input
              id="username"
              v-model="username"
              type="text"
              placeholder="your.email@school.com"
              :disabled="isLoading"
              autocomplete="username"
              class="w-full px-3 py-3 border-2 border-gray-300 rounded-lg text-base transition-colors box-border focus:outline-none focus:border-green-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
            />
          </div>

          <div class="mb-6">
            <label for="password" class="block mb-2 text-gray-600 font-medium">Password</label>
            <input
              id="password"
              v-model="password"
              type="password"
              placeholder="••••••••"
              :disabled="isLoading"
              autocomplete="current-password"
              class="w-full px-3 py-3 border-2 border-gray-300 rounded-lg text-base transition-colors box-border focus:outline-none focus:border-green-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
            />
          </div>

          <div v-if="error" class="p-4 bg-red-50 text-red-800 rounded-lg mb-4 border-l-4 border-red-800">
            {{ error }}
          </div>

          <button 
            type="submit" 
            :disabled="isLoading" 
            class="w-full px-4 py-3.5 bg-green-600 text-white border-none rounded-lg text-base font-semibold cursor-pointer transition-colors hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            {{ isLoading ? 'Signing in...' : 'Sign In' }}
          </button>
        </form>
      </div>
    </div>

    <!-- Logged In View -->
    <div v-else class="bg-white p-8 rounded-xl shadow-lg">
      <!-- Classes List View -->
      <div v-if="currentView === 'classes'">
        <div v-if="isLoading" class="text-center py-8">
          <p class="text-gray-600">Loading classes...</p>
        </div>

        <div v-else-if="classes.length > 0" class="mb-6">
          <div class="flex justify-between items-center mb-6">
            <h2 class="mt-0 mb-0 text-gray-800 text-2xl">Classes</h2>
            <button
              @click="logout"
              class="px-4 py-2 bg-red-600 text-white border-none rounded-lg text-sm font-semibold cursor-pointer transition-colors hover:bg-red-700"
            >
              Logout
            </button>
          </div>
          <div class="grid grid-cols-1 gap-3">
            <div 
              v-for="cls in classes" 
              :key="cls.id" 
              @click="openClass(cls)"
              class="bg-gray-100 text-gray-800 px-4 py-3 rounded-lg flex justify-between items-center hover:bg-gray-200 transition-colors cursor-pointer border-2 border-gray-300"
            >
              <span class="font-medium">{{ cls.name }}</span>
            </div>
          </div>
        </div>

        <div v-else class="text-center py-4">
          <p class="text-gray-600 mb-4">No classes found.</p>
          <button
            @click="logout"
            class="px-4 py-2 bg-red-600 text-white border-none rounded-lg text-sm font-semibold cursor-pointer transition-colors hover:bg-red-700"
          >
            Logout
          </button>
        </div>
      </div>

      <!-- Tasks List View -->
      <div v-else-if="currentView === 'tasks'">
        <div class="flex justify-between items-center mb-6">
          <div class="flex items-center gap-3">
            <button
              @click="backToClasses"
              class="px-3 py-2 bg-gray-200 text-gray-700 border-none rounded-lg text-sm font-semibold cursor-pointer transition-colors hover:bg-gray-300"
            >
              ← Back
            </button>
            <h2 class="mt-0 mb-0 text-gray-800 text-2xl">{{ selectedClass?.name }}</h2>
          </div>
          <button
            @click="logout"
            class="px-4 py-2 bg-red-600 text-white border-none rounded-lg text-sm font-semibold cursor-pointer transition-colors hover:bg-red-700"
          >
            Logout
          </button>
        </div>

        <!-- Tabs -->
        <div class="flex gap-2 mb-6 border-b-2 border-gray-200">
          <button
            @click="currentTab = 'tasks'"
            :class="[
              'px-4 py-2 font-semibold transition-colors',
              currentTab === 'tasks' 
                ? 'text-blue-600 border-b-2 border-blue-600 -mb-0.5' 
                : 'text-gray-600 hover:text-gray-800'
            ]"
          >
            Tasks
          </button>
          <button
            @click="currentTab = 'averages'"
            :class="[
              'px-4 py-2 font-semibold transition-colors',
              currentTab === 'averages' 
                ? 'text-blue-600 border-b-2 border-blue-600 -mb-0.5' 
                : 'text-gray-600 hover:text-gray-800'
            ]"
          >
            Grade Averages
          </button>
        </div>

        <div v-if="error" class="p-4 bg-red-50 text-red-800 rounded-lg mb-4 border-l-4 border-red-800">
          {{ error }}
        </div>

        <div v-if="isLoading" class="text-center py-8">
          <p class="text-gray-600">Loading...</p>
        </div>

        <!-- Tasks Tab -->
        <div v-else-if="currentTab === 'tasks'">
          <div v-if="tasks.length > 0" class="space-y-3">
            <div 
              v-for="task in tasks" 
              :key="task.id"
              @click="openTask(task)"
              class="bg-gray-50 p-4 rounded-lg border-2 border-gray-200 hover:border-blue-300 transition-colors cursor-pointer"
            >
              <div class="flex justify-between items-start gap-4">
                <div class="flex-1">
                  <h3 class="text-gray-800 font-semibold text-lg m-0 mb-2">{{ task.name }}</h3>
                  <div class="flex flex-wrap gap-2 text-sm text-gray-600">
                    <span v-if="task.date" class="bg-blue-100 text-blue-800 px-2 py-1 rounded">📅 {{ task.date }}</span>
                    <span 
                      v-if="task.category" 
                      class="px-2 py-1 rounded text-white font-medium"
                      :style="{ backgroundColor: task.categoryColor || '#f97316' }"
                    >{{ task.category }}</span>
                  </div>
                </div>
                <div 
                  v-if="task.grade || task.percentage !== null" 
                  class="text-right cursor-pointer hover:bg-blue-50 px-3 py-2 rounded-lg transition-colors"
                  @click="window.open(`https://opengate.managebac.com/student/classes/${task.classId}/core_tasks/${task.taskId}`, '_blank')"
                  title="Open in ManageBac"
                >
                  <div v-if="task.grade" class="text-gray-800 font-bold text-lg">{{ task.grade }}</div>
                  <div v-if="task.points" class="text-gray-600 text-sm">{{ task.points }}</div>
                  <div v-if="task.percentage !== null" class="text-green-600 font-semibold text-sm">{{ task.percentage }}%</div>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="text-center py-8">
            <p class="text-gray-600">No tasks found for this class.</p>
          </div>
        </div>

        <!-- Grade Averages Tab -->
        <div v-else-if="currentTab === 'averages'">
          <!-- Total Class Average -->
          <div v-if="gradeAverages.length > 0" class="bg-gray-100 p-5 rounded-lg mb-6 border-2 border-gray-300">
            <div class="flex justify-between items-center">
              <div>
                <h2 class="text-xl font-semibold m-0 text-gray-800">Final Weighted Grade</h2>
              </div>
              <div class="text-4xl font-bold text-green-600">
                {{ calculateTotalClassAverage() !== null ? calculateTotalClassAverage() + '%' : 'N/A' }}
              </div>
            </div>
          </div>

          <div v-if="gradeAverages.length > 0" class="space-y-4">
            <div 
              v-for="(category, categoryIndex) in gradeAverages" 
              :key="categoryIndex"
              class="bg-gray-50 p-4 rounded-lg border-2"
              :style="{ borderColor: category.color || '#d1d5db' }"
            >
              <div class="flex justify-between items-center mb-3 gap-4">
                <h3 
                  class="font-semibold text-lg m-0 flex items-center gap-2 flex-1"
                >
                  <span 
                    v-if="category.color"
                    class="inline-block w-4 h-4 rounded"
                    :style="{ backgroundColor: category.color }"
                  ></span>
                  <span class="text-gray-800">{{ category.category }}</span>
                </h3>
                <!-- TEMPORARY: Weight input (will be fetched from backend in the future) -->
                <div class="flex items-center gap-2">
                  <label class="text-sm text-gray-600">Weight:</label>
                  <input
                    type="number"
                    :value="getCategoryWeight(category.category)"
                    @input="updateCategoryWeight(category.category, $event.target.value)"
                    min="0"
                    max="100"
                    placeholder="0"
                    class="w-16 px-2 py-1 border-2 border-gray-300 rounded text-center font-semibold text-gray-700 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div class="text-green-600 font-bold text-xl">
                  {{ category.average !== null ? category.average + '%' : 'N/A' }}
                </div>
              </div>
              <div class="space-y-2">
                <div 
                  v-for="(task, taskIndex) in category.tasks" 
                  :key="taskIndex"
                  class="flex justify-between items-center py-2 px-3 bg-white rounded border border-gray-200 gap-3"
                >
                  <div class="flex-1">
                    <div class="text-gray-800 font-medium">{{ task.name }}</div>
                    <div v-if="task.date" class="text-gray-500 text-sm">{{ task.date }}</div>
                  </div>
                  <div class="flex items-center gap-2">
                    <button
                      v-if="isTaskModified(categoryIndex, taskIndex)"
                      @click="restoreOriginalValue(categoryIndex, taskIndex)"
                      class="px-2 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700 transition-colors"
                      title="Restore original value"
                    >
                      ↺ Reset
                    </button>
                    <div v-else class="w-16"></div>
                    <input
                      type="number"
                      :value="task.percentage ?? ''"
                      @input="updatePercentage(categoryIndex, taskIndex, $event.target.value)"
                      min="0"
                      max="100"
                      placeholder="--"
                      class="w-16 px-2 py-1 border-2 border-gray-300 rounded text-center font-semibold text-green-600 focus:outline-none focus:border-green-500"
                    />
                    <span class="text-green-600 font-semibold">%</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="text-center py-8">
            <p class="text-gray-600">No grade data available.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Copyright -->
    <div class="text-center text-gray-500 text-sm mt-12">
      © {{ new Date().getFullYear() }} Jan Hrubec. All rights reserved.
    </div>
  </div>
</template>

<style scoped>
</style>