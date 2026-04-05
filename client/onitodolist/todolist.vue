<template>
  <div class="todo-app">
    <div class="bg-pattern"></div>

    <div class="todo-container">
      <div class="todo-header">
        <h2 class="todo-title">
          <span class="title-dot">♦</span>
          <span class="title-text">ONITODO</span>
          <span class="title-dot">♦</span>
        </h2>
        <div class="button-group">
          <el-button type="default" class="cute-btn" @click="fetchTodos" :loading="refreshing">
            <el-icon>
              <Refresh />
            </el-icon>
            刷新
          </el-button>
          <el-button type="primary" class="cute-btn primary" @click="showAddDialog = true">
            <el-icon>
              <Plus />
            </el-icon>
            新增待办
          </el-button>
        </div>
      </div>

      <div class="todo-stats">
        <el-statistic title="总计" :value="todos.length" />
        <el-statistic title="已完成" :value="completedCount" />
        <el-statistic title="未完成" :value="pendingCount" />
      </div>

      <div class="search-filter-section">
        <el-input v-model="searchKeyword" placeholder="🔍 搜索标题或内容..." class="search-input cute-input" clearable />
        <div class="filter-buttons">
          <button :class="['filter-btn', { active: currentFilter === 'all' }]" @click="currentFilter = 'all'">
            全部
          </button>
          <button :class="['filter-btn', { active: currentFilter === 'active' }]" @click="currentFilter = 'active'">
            未完成
          </button>
          <button :class="['filter-btn', { active: currentFilter === 'completed' }]"
            @click="currentFilter = 'completed'">
            已完成
          </button>
        </div>
      </div>

      <div class="todo-table-card">
        <el-table :data="paginatedTodos" stripe style="width: 100%" v-loading="loading" class="cute-table">
          <el-table-column type="index" label="id" width="80" />
          <el-table-column prop="title" label="标题" min-width="150" show-overflow-tooltip>
            <template #default="{ row }">
              <span :class="{ 'completed-text': row.completed }">{{ row.title }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="content" label="内容" min-width="150" show-overflow-tooltip />
          <el-table-column prop="createdBy" label="创建人" width="80" show-overflow-tooltip />
          <el-table-column prop="completed" label="状态" width="80">
            <template #default="{ row }">
              <el-tag :type="row.completed ? 'success' : 'warning'" size="small" class="cute-tag">
                {{ row.completed ? '已完成' : '未完成' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="createdAt" label="创建时间" width="180">
            <template #default="{ row }">
              {{ formatDate(row.createdAt) }}
            </template>
          </el-table-column>
          <el-table-column label="操作" width="200" fixed="right">
            <template #default="{ row }">
              <el-button v-if="!row.completed" size="small" type="success" class="cute-btn"
                @click="toggleComplete(row, true)">
                完成
              </el-button>
              <el-button v-else size="small" type="warning" class="cute-btn" @click="toggleComplete(row, false)">
                取消
              </el-button>
              <el-button size="small" type="primary" class="cute-btn" @click="editTodo(row)">
                编辑
              </el-button>
              <el-button size="small" type="danger" class="cute-btn" @click="deleteTodo(row)">
                删除
              </el-button>
            </template>
          </el-table-column>
        </el-table>

        <el-empty v-if="filteredTodos.length === 0 && !loading" description="暂无待办事项" />

        <div v-if="filteredTodos.length > 8" class="pagination-section">
          <el-pagination v-model:current-page="currentPage" v-model:page-size="pageSize" :page-sizes="[8, 16, 32, 64]"
            :total="filteredTodos.length" layout="total, sizes, prev, pager, next, jumper" background
            @size-change="handleSizeChange" @current-change="handleCurrentChange" />
        </div>
      </div>
    </div>

    <el-dialog v-model="showAddDialog" title="新增待办事项" width="500px" class="cute-dialog">
      <el-form :model="addForm" label-width="80px">
        <el-form-item label="标题">
          <el-input v-model="addForm.title" placeholder="请输入标题" class="cute-input" />
        </el-form-item>
        <el-form-item label="内容">
          <el-input v-model="addForm.content" type="textarea" :rows="4" placeholder="请输入具体内容" class="cute-input" />
        </el-form-item>
        <el-form-item label="创建人">
          <el-input v-model="addForm.createdBy" placeholder="默认为：默认创建人" class="cute-input" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false" class="cute-btn">取消</el-button>
        <el-button type="primary" @click="addTodo" :loading="saving" class="cute-btn primary">
          保存
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showEditDialog" title="编辑待办事项" width="500px" class="cute-dialog">
      <el-form :model="editForm" label-width="80px">
        <el-form-item label="标题">
          <el-input v-model="editForm.title" placeholder="请输入标题" class="cute-input" />
        </el-form-item>
        <el-form-item label="内容">
          <el-input v-model="editForm.content" type="textarea" :rows="4" placeholder="请输入具体内容" class="cute-input" />
        </el-form-item>
        <el-form-item label="创建人">
          <el-input v-model="editForm.createdBy" placeholder="请输入创建人" class="cute-input" />
        </el-form-item>
        <el-form-item label="状态">
          <el-checkbox v-model="editForm.completed" class="cute-checkbox">
            已完成
          </el-checkbox>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditDialog = false" class="cute-btn">取消</el-button>
        <el-button type="primary" @click="updateTodo" :loading="saving" class="cute-btn primary">
          保存
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script lang="ts" setup>
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh } from '@element-plus/icons-vue'
import { send } from '@koishijs/client'

interface TodoItem {
  id: number
  title: string
  content: string
  completed: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
}

const todos = ref<TodoItem[]>([])
const loading = ref(false)
const saving = ref(false)
const refreshing = ref(false)
const showAddDialog = ref(false)
const showEditDialog = ref(false)
const searchKeyword = ref('')
const currentFilter = ref<'all' | 'active' | 'completed'>('all')
const currentPage = ref(1)
const pageSize = ref(8)

const addForm = ref({
  title: '',
  content: '',
  createdBy: '',
})

const editForm = ref({
  id: 0,
  title: '',
  content: '',
  createdBy: '',
  completed: false,
})

const completedCount = computed(() => todos.value.filter(t => t.completed).length)
const pendingCount = computed(() => todos.value.filter(t => !t.completed).length)

const filteredTodos = computed(() => {
  let result = todos.value

  if (currentFilter.value === 'active') {
    result = result.filter(t => !t.completed)
  } else if (currentFilter.value === 'completed') {
    result = result.filter(t => t.completed)
  }

  if (searchKeyword.value.trim()) {
    const keyword = searchKeyword.value.toLowerCase().trim()
    result = result.filter(t =>
      t.title.toLowerCase().includes(keyword) ||
      t.content.toLowerCase().includes(keyword)
    )
  }

  currentPage.value = 1
  return result
})

const paginatedTodos = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  const end = start + pageSize.value
  return filteredTodos.value.slice(start, end)
})

function handleSizeChange(val: number) {
  pageSize.value = val
  currentPage.value = 1
}

function handleCurrentChange(val: number) {
  currentPage.value = val
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleString('zh-CN')
}

function fetchTodos() {
  refreshing.value = true
  send('onitodos/list').then((data: TodoItem[]) => {
    todos.value = data
    refreshing.value = false
    ElMessage.success('刷新成功')
  }).catch((err) => {
    refreshing.value = false
    ElMessage.error('刷新失败')
    console.error(err)
  })
}

send('onitodos/list').then((data: TodoItem[]) => {
  todos.value = data
})

async function addTodo() {
  if (!addForm.value.title.trim()) {
    ElMessage.warning('请输入标题')
    return
  }
  saving.value = true
  try {
    await send('onitodos/add', {
      title: addForm.value.title,
      content: addForm.value.content,
      createdBy: addForm.value.createdBy,
    })
    ElMessage.success('添加成功')
    showAddDialog.value = false
    addForm.value = { title: '', content: '', createdBy: '' }
    fetchTodos()
  } catch (err) {
    ElMessage.error('添加失败')
    console.error(err)
  } finally {
    saving.value = false
  }
}

function editTodo(todo: TodoItem) {
  editForm.value = {
    id: todo.id,
    title: todo.title,
    content: todo.content,
    createdBy: todo.createdBy,
    completed: todo.completed,
  }
  showEditDialog.value = true
}

async function updateTodo() {
  if (!editForm.value.title.trim()) {
    ElMessage.warning('请输入标题')
    return
  }
  saving.value = true
  try {
    await send('onitodos/update', {
      id: editForm.value.id,
      title: editForm.value.title,
      content: editForm.value.content,
      createdBy: editForm.value.createdBy,
      completed: editForm.value.completed,
    })
    ElMessage.success('更新成功')
    showEditDialog.value = false
    fetchTodos()
  } catch (err) {
    ElMessage.error('更新失败')
    console.error(err)
  } finally {
    saving.value = false
  }
}

async function toggleComplete(todo: TodoItem, completed: boolean) {
  try {
    await send('onitodos/update', {
      id: todo.id,
      completed,
    })
    ElMessage.success(completed ? '标记完成成功' : '取消完成成功')
    fetchTodos()
  } catch (err) {
    ElMessage.error('操作失败')
    console.error(err)
  }
}

async function deleteTodo(todo: TodoItem) {
  try {
    await ElMessageBox.confirm(
      `确定要删除待办事项 "${todo.title}" 吗？`,
      '确认删除',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning',
      }
    )
    await send('onitodos/delete', { id: todo.id })
    ElMessage.success('删除成功')
    fetchTodos()
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('删除失败')
      console.error(err)
    }
  }
}
</script>

<style lang="scss" scoped>
.todo-app {
  min-height: 100vh;
  position: relative;
  background: linear-gradient(135deg, #e0f4ff 0%, #f0f8ff 50%, #e8f5ff 100%);
  padding: 20px;
}

.bg-pattern {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-image: radial-gradient(circle, #b8d4e8 1px, transparent 1px);
  background-size: 25px 25px;
  opacity: 0.5;
  pointer-events: none;
  z-index: 0;
}

.todo-container {
  position: relative;
  z-index: 1;
  max-width: 1000px;
  margin: 0 auto;
}

.todo-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.todo-title {
  font-family: 'Comic Sans MS', cursive, sans-serif;
  font-size: 48px;
  font-weight: bold;
  color: #fff;
  text-shadow:
    2px 2px 0 #333,
    -2px -2px 0 #333,
    2px -2px 0 #333,
    -2px 2px 0 #333,
    0px 2px 0 #333,
    0px -2px 0 #333,
    2px 0px 0 #333,
    -2px 0px 0 #333,
    3px 3px 0 #ffd700,
    4px 4px 0 #333;
  letter-spacing: 5px;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin: 0;
}

.title-dot {
  color: #ff6b9d;
  font-size: 16px;
  animation: bounce 0.6s infinite alternate;
}

@keyframes bounce {
  from {
    transform: translateY(0);
  }

  to {
    transform: translateY(-6px);
  }
}

.title-text {
  background: linear-gradient(180deg, #fff 0%, #f0f0f0 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.button-group {
  display: flex;
  gap: 10px;
}

.cute-btn {
  background: #fff;
  border: 2px solid #333;
  color: #333;
  font-family: 'Comic Sans MS', cursive, sans-serif;
  border-radius: 8px;
  box-shadow: 3px 3px 0 #333;
  transition: all 0.1s;

  &:hover {
    transform: translate(1px, 1px);
    box-shadow: 2px 2px 0 #333;
  }

  &:active {
    transform: translate(2px, 2px);
    box-shadow: 1px 1px 0 #333;
  }

  &.primary {
    background: linear-gradient(135deg, #ffb6c1 0%, #ffc0cb 100%);
  }
}

.todo-stats {
  display: flex;
  gap: 20px;
  margin-bottom: 15px;
  padding: 8px 15px;
  background: #fff;
  border: 2px solid #333;
  border-radius: 10px;
  box-shadow: 4px 4px 0 #333;
}

.search-filter-section {
  display: flex;
  gap: 15px;
  margin-bottom: 20px;
  align-items: center;
  flex-wrap: wrap;
}

.search-input {
  flex: 1;
  min-width: 250px;
}

.filter-buttons {
  display: flex;
  gap: 10px;
}

.filter-btn {
  background: #fff;
  border: 2px solid #333;
  color: #333;
  font-family: 'Comic Sans MS', cursive, sans-serif;
  padding: 8px 20px;
  border-radius: 8px;
  box-shadow: 3px 3px 0 #333;
  cursor: pointer;
  transition: all 0.1s;

  &:hover {
    transform: translate(1px, 1px);
    box-shadow: 2px 2px 0 #333;
  }

  &:active {
    transform: translate(2px, 2px);
    box-shadow: 1px 1px 0 #333;
  }

  &.active {
    background: linear-gradient(135deg, #87ceeb 0%, #98d8c8 100%);
  }
}

.todo-table-card {
  background: #fff;
  border: 3px solid #333;
  border-radius: 15px;
  box-shadow: 8px 8px 0 #333;
  overflow: hidden;
}

.cute-table {
  font-family: 'Comic Sans MS', cursive, sans-serif;

  :deep(.el-table__header) {
    th {
      background: linear-gradient(135deg, #87ceeb 0%, #98d8c8 100%);
      color: #333;
      font-weight: bold;
    }
  }
}

.completed-text {
  text-decoration: line-through;
  color: #909399;
}

.cute-tag {
  font-family: 'Comic Sans MS', cursive, sans-serif;
  border: 2px solid #333;
}

:deep(.el-dialog) {
  border: 3px solid #333;
  border-radius: 15px;
  box-shadow: 8px 8px 0 #333;
}

:deep(.el-dialog__header) {
  background: linear-gradient(135deg, #87ceeb 0%, #98d8c8 100%);
  border-bottom: 3px solid #333;
  margin: 0;
  padding: 15px 20px;

  .el-dialog__title {
    font-family: 'Comic Sans MS', cursive, sans-serif;
    font-weight: bold;
    color: #333;
  }
}

.cute-input {
  :deep(.el-input__wrapper) {
    border: 2px solid #333;
    border-radius: 8px;
    box-shadow: none;
  }
}

.cute-checkbox {
  font-family: 'Comic Sans MS', cursive, sans-serif;
  color: #333;

  :deep(.el-checkbox__input) {
    .el-checkbox__inner {
      border: 2px solid #333;
      border-radius: 4px;
      box-shadow: 2px 2px 0 #333;

      &:hover {
        transform: translate(1px, 1px);
        box-shadow: 1px 1px 0 #333;
      }
    }

    &.is-checked {
      .el-checkbox__inner {
        background: linear-gradient(135deg, #87ceeb 0%, #98d8c8 100%);
        border-color: #333;
      }
    }
  }
}

:deep(.el-statistic__head) {
  color: inherit;
  font-family: 'Comic Sans MS', cursive, sans-serif;
  font-size: 14px;
}

:deep(.el-statistic__content) {
  color: inherit;
  font-family: 'Comic Sans MS', cursive, sans-serif;
  font-size: 20px;
}

.pagination-section {
  padding: 20px;
  display: flex;
  justify-content: center;
  border-top: 2px solid #333;
  background: linear-gradient(135deg, #f5f5f5 0%, #fff 100%);
}

:deep(.el-pagination) {
  font-family: 'Comic Sans MS', cursive, sans-serif;

  button,
  li {
    border: 2px solid #333;
    border-radius: 8px;
    box-shadow: 2px 2px 0 #333;
    transition: all 0.1s;

    &:hover {
      transform: translate(1px, 1px);
      box-shadow: 1px 1px 0 #333;
    }

    &.is-active {
      background: linear-gradient(135deg, #87ceeb 0%, #98d8c8 100%);
      color: #333;
      font-weight: bold;
    }
  }

  .el-pager li {
    border-radius: 8px;
  }

  .el-pagination__sizes,
  .el-pagination__jump {
    .el-select .el-input__wrapper {
      border: 2px solid #333;
      border-radius: 8px;
      box-shadow: 2px 2px 0 #333;
    }

    .el-input__wrapper {
      border: 2px solid #333;
      border-radius: 8px;
      box-shadow: 2px 2px 0 #333;
    }
  }
}

@media (max-width: 768px) {
  .todo-app {
    padding: 10px;
  }

  .todo-header {
    flex-direction: column;
    gap: 15px;
    align-items: stretch;
  }

  .todo-title {
    font-size: 32px;
    letter-spacing: 2px;
    justify-content: center;
  }

  .title-dot {
    font-size: 12px;
  }

  .button-group {
    justify-content: center;
    flex-wrap: wrap;
  }

  .cute-btn {
    font-size: 14px;
    padding: 8px 12px;
  }

  .todo-stats {
    flex-wrap: wrap;
    justify-content: center;
    gap: 10px;
  }

  :deep(.el-statistic) {
    text-align: center;
  }

  :deep(.el-statistic__content) {
    font-size: 18px;
  }

  .search-filter-section {
    flex-direction: column;
    align-items: stretch;
  }

  .search-input {
    min-width: auto;
    width: 100%;
  }

  .filter-buttons {
    justify-content: center;
    flex-wrap: wrap;
  }

  .filter-btn {
    padding: 6px 14px;
    font-size: 14px;
  }

  .todo-table-card {
    border-radius: 10px;
    box-shadow: 4px 4px 0 #333;
  }

  :deep(.el-dialog) {
    width: 95% !important;
    margin: 5vh auto !important;
    max-width: 400px;
  }

  :deep(.el-dialog__header) {
    padding: 12px 16px;
  }

  :deep(.el-dialog__body) {
    padding: 15px;
  }

  .pagination-section {
    padding: 15px 10px;
  }

  :deep(.el-pagination) {
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;

    .el-pagination__sizes,
    .el-pagination__jump {
      margin: 0;
    }

    button,
    li {
      min-width: 32px;
      height: 32px;
      line-height: 28px;
      padding: 0 8px;
    }
  }
}

@media (max-width: 480px) {
  .todo-title {
    font-size: 24px;
    letter-spacing: 1px;
  }

  .title-dot {
    font-size: 10px;
  }

  .cute-btn {
    font-size: 13px;
    padding: 7px 10px;
  }

  .filter-btn {
    padding: 5px 12px;
    font-size: 13px;
  }

  :deep(.el-dialog) {
    width: 92% !important;
  }
}
</style>
