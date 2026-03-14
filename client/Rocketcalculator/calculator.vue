<template>
    <k-layout class="rocket-calculator sci-fi-bg">
        <el-scrollbar>
            <!-- <div class="rocket-calculator sci-fi-bg"> -->
            <!-- 背景装饰网格 -->
            <div class="grid-overlay"></div>

            <k-card class="header-card sci-fi-card">
                <div class="header-glow"></div>
                <h1 class="sci-fi-title">ONI ROCKET CALCULATOR</h1>
                <p class="sci-fi-subtitle">缺氧火箭最优配置解算系统 · 基于官方物理引擎</p>

                <div class="content-layout">
                    <!-- 左侧：输入控制台 -->
                    <k-card class="form-card sci-fi-card">
                        <div class="card-header-line"></div>

                        <!-- 主配置 -->
                        <div class="config-section">
                            <h3 class="section-title">【核心参数】</h3>

                            <el-form :model="form" size="large" class="sci-fi-form"
                                :label-position="isMobile ? 'top' : 'right'">
                                <el-form-item label="引擎类型">
                                    <el-select v-model="form.type" style="width: 100%" class="sci-fi-select">
                                        <el-option label="蒸汽引擎" value="steam" />
                                        <el-option label="石油引擎" value="oil" />
                                        <el-option label="液氢引擎" value="hydrogen" />
                                        <el-option label="生物柴油引擎" value="biodiesel" />
                                    </el-select>
                                </el-form-item>

                                <el-form-item label="目标轨道">
                                    <div class="distance-control">
                                        <!-- 10000km 一档的步进选择器 -->
                                        <div class="distance-step-selector">
                                            <el-button v-for="dist in distanceOptions" :key="dist"
                                                :class="['step-btn', { active: form.distance === dist }]"
                                                @click="form.distance = dist">
                                                {{ dist / 1000 }}k
                                            </el-button>
                                        </div>
                                        <div class="distance-input-wrapper">
                                            <span class="distance-label">当前：</span>
                                            <span class="distance-value">{{ form.distance.toLocaleString() }}</span>
                                            <span class="unit">km</span>
                                        </div>
                                    </div>
                                </el-form-item>

                                <el-form-item label="氧化剂" v-if="form.type !== 'steam'">
                                    <el-radio-group v-model="form.oxygenType" class="sci-fi-radio-group">
                                        <el-radio-button label="solid">氧石</el-radio-button>
                                        <el-radio-button label="liquid">液氧</el-radio-button>
                                    </el-radio-group>
                                    <div class="oxidizer-hint">
                                        <span :class="['hint-item', { active: form.oxygenType === 'solid' }]">1.0x
                                            效率</span>
                                        <span :class="['hint-item', { active: form.oxygenType === 'liquid' }]">1.33x
                                            效率</span>
                                    </div>
                                </el-form-item>
                            </el-form>
                        </div>

                        <div class="divider-line"></div>

                        <!-- 可选模块 -->
                        <div class="config-section">
                            <h3 class="section-title">【载荷配置】</h3>

                            <el-form :model="form" size="large" class="modules-form"
                                :label-position="isMobile ? 'top' : 'right'">
                                <div class="modules-grid">
                                    <div v-for="(label, key) in MODULE_LABELS" :key="key" class="module-item">
                                        <div class="module-header">
                                            <span class="module-name">{{ label }}</span>
                                        </div>
                                        <el-input-number v-model="form[key]" :min="0" :max="20" class="module-input" />
                                    </div>
                                </div>

                                <el-form-item class="calculate-btn-wrapper">
                                    <el-button @click="handleCalculate" class="sci-fi-calculate-btn">
                                        <span class="btn-text">▶ 执行解算</span>
                                        <span class="btn-glow"></span>
                                    </el-button>
                                </el-form-item>
                            </el-form>
                        </div>
                    </k-card>

                    <!-- 右侧：结果显示面板 -->
                    <k-card class="result-card sci-fi-card">
                        <div class="card-header-line"></div>

                        <template v-if="!result">
                            <div class="empty-state">
                                <div class="scan-line"></div>
                                <div class="empty-icon">📡</div>
                                <p class="empty-text">等待输入参数...</p>
                                <p class="empty-hint">请在左侧配置核心参数与载荷</p>
                            </div>
                        </template>

                        <template v-else-if="result.length === 0">
                            <div class="empty-state">
                                <div class="empty-icon">⚠️</div>
                                <p class="empty-text error">解算失败</p>
                                <p class="empty-hint">无法找到满足条件的配置，请尝试减少载荷</p>
                                <el-button @click="handleReset" class="sci-fi-reset-btn">重置参数</el-button>
                            </div>
                        </template>

                        <template v-else>
                            <div class="result-header">
                                <h3 class="result-title">✅ 最优解算结果</h3>
                                <div class="result-status">
                                    <span class="status-dot"></span>
                                    <span>CONVERGED</span>
                                </div>
                            </div>

                            <div class="key-stats">
                                <div class="stat-item primary">
                                    <div class="stat-label">总起飞重量</div>
                                    <div class="stat-value">{{ result[0].weight.toLocaleString() }} <span
                                            class="stat-unit">kg</span></div>
                                </div>
                                <div class="stat-item success">
                                    <div class="stat-label">预计射程</div>
                                    <div class="stat-value">{{ result[0].finalDistance.toLocaleString() }} <span
                                            class="stat-unit">km</span></div>
                                </div>
                                <div class="stat-item warning">
                                    <div class="stat-label">质量惩罚</div>
                                    <div class="stat-value">{{ result[0].punish.toLocaleString() }} <span
                                            class="stat-unit">km</span></div>
                                </div>
                            </div>

                            <el-divider class="sci-fi-divider" />

                            <div class="detail-stats">
                                <h4 class="detail-title">【配置详情】</h4>
                                <div class="detail-grid">
                                    <!-- 燃料/蒸汽填充量：所有引擎都显示 -->
                                    <div class="detail-item">
                                        <span class="detail-label">{{ form.type === 'steam' ? '蒸汽填充量' : '燃料填充量'
                                        }}</span>
                                        <span class="detail-value">{{ result[0].capacity.toLocaleString() }}
                                            kg</span>
                                    </div>
                                    <!-- 助推器数量 -->
                                    <div class="detail-item">
                                        <span class="detail-label">助推器数量</span>
                                        <span class="detail-value">{{ result[0].booster }} 个</span>
                                    </div>
                                    <!-- 燃料舱数量：非蒸汽引擎显示 -->
                                    <div class="detail-item" v-if="result[0].fuelCount !== undefined">
                                        <span class="detail-label">燃料舱数量</span>
                                        <span class="detail-value">{{ result[0].fuelCount }} 个</span>
                                    </div>
                                    <!-- 氧化剂舱数量：非蒸汽引擎显示 -->
                                    <div class="detail-item" v-if="result[0].oxygenCount !== undefined">
                                        <span class="detail-label">氧化剂舱数量</span>
                                        <span class="detail-value">{{ result[0].oxygenCount }} 个</span>
                                    </div>
                                </div>
                            </div>

                            <el-divider class="sci-fi-divider" />

                            <div class="data-table-section">
                                <h4 class="detail-title">【原始数据】</h4>
                                <div class="table-wrapper">
                                    <el-table :data="result" stripe class="sci-fi-table">
                                        <el-table-column prop="weight" label="总重(kg)" sortable />
                                        <el-table-column prop="finalDistance" label="射程(km)" sortable />
                                        <el-table-column prop="booster" label="助推器" />
                                        <el-table-column prop="fuelCount" label="燃料舱" />
                                        <el-table-column prop="oxygenCount" label="氧化剂舱" />
                                    </el-table>
                                </div>
                            </div>
                        </template>
                    </k-card>
                </div>
            </k-card>
        </el-scrollbar>
    </k-layout>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed } from "vue";
import { ElMessage } from "element-plus";
import { calculateRocket } from "./calculator";
import { MODULE_LABELS, CalculatorInput, RocketSolution } from "./config";

const isMobile = ref(false);
const checkIsMobile = () => {
    isMobile.value = window.innerWidth <= 768;
};

// 生成距离选项：10000km 到 190000km，步长 10000km
const distanceOptions = computed(() => {
    const options = [];
    for (let i = 10000; i <= 190000; i += 10000) {
        options.push(i);
    }
    return options;
});

onMounted(() => {
    checkIsMobile();
    window.addEventListener("resize", checkIsMobile);
});
onUnmounted(() => {
    window.removeEventListener("resize", checkIsMobile);
});

const form = reactive<CalculatorInput>({
    type: "steam",
    distance: 10000,
    oxygenType: "solid",
    allowWaste: false,
    ResearchModule: 0,
    CargoBay: 0,
    GasCargoBay: 0,
    LiquidCargoBay: 0,
    SpecialCargoBay: 0,
    TouristModule: 0,
    RoboPilotCommandModule: 0,
});

const result = ref<RocketSolution[] | null>(null);

const handleCalculate = () => {
    try {
        const res = calculateRocket(form);
        result.value = res;
        if (res.length > 0) {
            ElMessage.success("解算完成！已收敛到最优解");
            if (isMobile.value) {
                setTimeout(() => {
                    document.querySelector(".result-card")?.scrollIntoView({ behavior: "smooth" });
                }, 100);
            }
        } else {
            ElMessage.warning("解算失败，无解空间");
        }
    } catch (e) {
        ElMessage.error("解算器异常");
        console.error(e);
    }
};

const handleReset = () => {
    form.type = "steam";
    form.distance = 10000;
    form.oxygenType = "solid";
    form.ResearchModule = 0;
    form.CargoBay = 0;
    form.GasCargoBay = 0;
    form.LiquidCargoBay = 0;
    form.SpecialCargoBay = 0;
    form.TouristModule = 0;
    form.RoboPilotCommandModule = 0;
    result.value = null;
};
</script>
<style lang="css" scoped>
* {
    box-sizing: border-box;
}

/* ===================== 科幻基础样式 ===================== */
.rocket-calculator {
    max-width: 1400px;
    margin: 0 auto;
    padding: 20px;
    box-sizing: border-box;
    position: relative;
    min-height: 100vh;
    overflow-x: hidden;
}

/* 深空背景 */
.sci-fi-bg .main-container {
    background: linear-gradient(135deg, #0a0e27 0%, #1a1f3a 50%, #0f172a 100%);
    color: #e0e7ff;
}

/* 背景网格 */
.grid-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-image:
        linear-gradient(rgba(0, 255, 255, 0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0, 255, 255, 0.03) 1px, transparent 1px);
    background-size: 40px 40px;
    pointer-events: none;
    z-index: 0;
}

/* 科幻卡片 */
.sci-fi-card {
    background: rgba(15, 23, 42, 0.95);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(0, 255, 255, 0.2);
    box-shadow:
        0 0 20px rgba(0, 255, 255, 0.1),
        inset 0 0 20px rgba(0, 0, 0, 0.5);
    position: relative;
    overflow: visible;
    z-index: 1;
}

.sci-fi-card :deep(.k-card__body) {
    padding: 24px;
}

/* 卡片顶部发光线 */
.card-header-line {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent, #00ffff, #8b5cf6, transparent);
    animation: lineGlow 3s ease-in-out infinite;
    z-index: 1;
}

@keyframes lineGlow {

    0%,
    100% {
        opacity: 0.5;
    }

    50% {
        opacity: 1;
    }
}

/* ===================== 头部样式 ===================== */
.header-card {
    margin-bottom: 24px;
    text-align: center;
    position: relative;
    z-index: 10;
    margin-top: 8px;
}

.header-glow {
    position: absolute;
    top: -50%;
    left: 50%;
    transform: translateX(-50%);
    width: 200%;
    height: 100%;
    background: radial-gradient(ellipse, rgba(139, 92, 246, 0.15) 0%, transparent 70%);
    pointer-events: none;
    z-index: -1;
}

.sci-fi-title {
    margin: 0 0 8px 0;
    font-size: 28px;
    font-weight: 800;
    letter-spacing: 4px;
    color: #00ffff;
    background: linear-gradient(90deg, #00ffff, #8b5cf6, #00ffff);
    background-size: 200% auto;
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    animation: titleShine 4s linear infinite;
    position: relative;
    z-index: 2;
    text-shadow: 0 0 30px rgba(0, 255, 255, 0.3);
    line-height: 1.4;
    word-break: keep-all;
    white-space: nowrap;
}

@keyframes titleShine {
    0% {
        background-position: 0% center;
    }

    100% {
        background-position: 200% center;
    }
}

.sci-fi-subtitle {
    margin: 0;
    color: #64748b;
    font-size: 13px;
    letter-spacing: 2px;
    text-transform: uppercase;
    position: relative;
    z-index: 2;
    word-break: break-all;
    line-height: 1.5;
}

/* ===================== 布局 ===================== */
.content-layout {
    display: grid;
    grid-template-areas: 460px 1fr;
    gap: 24px;
    position: relative;
    z-index: 1;
}

/* ===================== 表单样式 ===================== */
.config-section {
    margin-bottom: 20px;
    position: relative;
    z-index: 1;
}

.section-title {
    margin: 0 0 20px 0;
    font-size: 14px;
    color: #00ffff;
    letter-spacing: 2px;
    font-weight: 600;
}

/* 距离控制 */
.distance-control {
    width: 100%;
}

.distance-step-selector {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 8px;
    margin-bottom: 16px;
}

.step-btn {
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(0, 255, 255, 0.2);
    color: #94a3b8;
    padding: 8px 4px;
    font-size: 12px;
    font-weight: 600;
    transition: all 0.2s ease;
    white-space: nowrap;
}

.step-btn:hover {
    border-color: rgba(0, 255, 255, 0.5);
    color: #00ffff;
    transform: translateY(-1px);
}

.step-btn.active {
    background: rgba(0, 255, 255, 0.15);
    border-color: #00ffff;
    color: #00ffff;
    box-shadow: 0 0 15px rgba(0, 255, 255, 0.3);
}

.distance-input-wrapper {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(139, 92, 246, 0.3);
    border-radius: 4px;
    flex-wrap: nowrap;
}

.distance-label {
    color: #64748b;
    font-size: 13px;
    flex-shrink: 0;
}

.distance-value {
    font-size: 20px;
    font-weight: 800;
    color: #8b5cf6;
    word-break: keep-all;
}

.unit {
    color: #8b5cf6;
    font-weight: 600;
    font-size: 14px;
    flex-shrink: 0;
}

/* 模块网格 */
.modules-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
}

.module-item {
    background: rgba(0, 255, 255, 0.05);
    border: 1px solid rgba(0, 255, 255, 0.1);
    padding: 12px;
    border-radius: 4px;
    transition: all 0.3s ease;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.module-item:hover {
    border-color: rgba(0, 255, 255, 0.3);
    background: rgba(0, 255, 255, 0.08);
}

.module-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.module-name {
    font-size: 13px;
    color: #94a3b8;
}

/* 修复输入数字和加减号样式 */
.module-input {
    width: 100%;
}

.module-input :deep(.el-input__wrapper) {
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(0, 255, 255, 0.2);
    box-shadow: none;
    padding: 4px 6px;
}

.module-input :deep(.el-input__inner) {
    text-align: center;
    color: #00ffff;
    font-weight: 700;
    font-size: 16px;
}

/* 高亮加减号，确保清晰可见 */
.module-input :deep(.el-input-number__decrease),
.module-input :deep(.el-input-number__increase) {
    background: rgba(0, 255, 255, 0.2);
    color: #00ffff;
    border-color: rgba(0, 255, 255, 0.3);
    font-weight: 800;
    font-size: 16px;
    transition: all 0.2s ease;
}

.module-input :deep(.el-input-number__decrease:hover),
.module-input :deep(.el-input-number__increase:hover) {
    background: rgba(0, 255, 255, 0.4);
    color: #ffffff;
}

.module-input :deep(.el-input-number__decrease.is-disabled),
.module-input :deep(.el-input-number__increase.is-disabled) {
    background: rgba(0, 0, 0, 0.2);
    color: #475569;
    border-color: rgba(255, 255, 255, 0.1);
}

/* 科幻按钮 */
.calculate-btn-wrapper {
    margin-top: 24px;
    margin-bottom: 0;
}

.sci-fi-calculate-btn {
    width: 100%;
    height: 50px;
    background: linear-gradient(135deg, #00ffff 0%, #8b5cf6 100%);
    border: none;
    color: #0a0e27;
    font-weight: 800;
    font-size: 16px;
    letter-spacing: 2px;
    position: relative;
    overflow: hidden;
    transition: all 0.3s ease;
}

.sci-fi-calculate-btn:hover {
    transform: translateY(-2px);
    box-shadow: 0 10px 30px rgba(0, 255, 255, 0.3);
}

.btn-text {
    position: relative;
    z-index: 1;
}

.btn-glow {
    position: absolute;
    top: 0;
    left: -100%;
    width: 100%;
    height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.4), transparent);
    animation: btnScan 2s ease-in-out infinite;
}

@keyframes btnScan {
    0% {
        left: -100%;
    }

    100% {
        left: 100%;
    }
}

.sci-fi-radio-group {
    width: 100%;
    display: flex;
}

.sci-fi-radio-group :deep(.el-radio-button) {
    flex: 1;
}

.sci-fi-radio-group :deep(.el-radio-button__inner) {
    width: 100%;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(0, 255, 255, 0.2);
    color: #94a3b8;
    font-weight: 600;
    padding: 12px 10px;
    transition: all 0.2s ease;
}

.sci-fi-radio-group :deep(.el-radio-button__inner:hover) {
    color: #00ffff;
    border-color: rgba(0, 255, 255, 0.4);
}

.sci-fi-radio-group :deep(.el-radio-button__orig-radio:checked + .el-radio-button__inner) {
    background: rgba(0, 255, 255, 0.15);
    border-color: #00ffff;
    color: #00ffff;
    box-shadow: 0 0 15px rgba(0, 255, 255, 0.2);
}

/* 氧化剂效率提示 */
.oxidizer-hint {
    display: flex;
    justify-content: space-around;
    margin-top: 8px;
}

.hint-item {
    font-size: 12px;
    color: #64748b;
    transition: all 0.2s ease;
}

.hint-item.active {
    color: #00ffff;
    font-weight: 600;
}

/* 分割线 */
.divider-line {
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(0, 255, 255, 0.3), transparent);
    margin: 24px 0;
}

/* ===================== 结果样式 ===================== */
.result-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
    flex-wrap: wrap;
    gap: 8px;
}

.result-title {
    margin: 0;
    font-size: 18px;
    color: #00ffff;
    letter-spacing: 2px;
}

.result-status {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: #67c23a;
    letter-spacing: 1px;
    flex-shrink: 0;
}

.status-dot {
    width: 8px;
    height: 8px;
    background: #67c23a;
    border-radius: 50%;
    animation: statusPulse 2s ease-in-out infinite;
}

@keyframes statusPulse {

    0%,
    100% {
        box-shadow: 0 0 0 0 rgba(103, 194, 58, 0.4);
    }

    50% {
        box-shadow: 0 0 0 8px rgba(103, 194, 58, 0);
    }
}

/* 关键数据 */
.key-stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    margin-bottom: 24px;
}

.stat-item {
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 16px;
    text-align: center;
    position: relative;
}

.stat-item.primary {
    border-color: rgba(0, 255, 255, 0.4);
    box-shadow: 0 0 20px rgba(0, 255, 255, 0.1);
}

.stat-item.success {
    border-color: rgba(103, 194, 58, 0.4);
    box-shadow: 0 0 20px rgba(103, 194, 58, 0.1);
}

.stat-item.warning {
    border-color: rgba(230, 162, 60, 0.4);
    box-shadow: 0 0 20px rgba(230, 162, 60, 0.1);
}

.stat-label {
    font-size: 12px;
    color: #64748b;
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 1px;
}

.stat-value {
    font-size: 24px;
    font-weight: 800;
}

.stat-item.primary .stat-value {
    color: #00ffff;
}

.stat-item.success .stat-value {
    color: #67c23a;
}

.stat-item.warning .stat-value {
    color: #e6a23c;
}

.stat-unit {
    font-size: 14px;
    opacity: 0.7;
}

/* 详情数据 */
.detail-title {
    margin: 0 0 16px 0;
    font-size: 14px;
    color: #8b5cf6;
    letter-spacing: 2px;
}

.detail-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
}

.detail-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: rgba(0, 0, 0, 0.2);
    padding: 12px 16px;
    border-left: 3px solid #8b5cf6;
    flex-wrap: nowrap;
    gap: 8px;
}

.detail-label {
    font-size: 13px;
    color: #94a3b8;
    flex-shrink: 0;
}

.detail-value {
    font-size: 16px;
    font-weight: 700;
    color: #e0e7ff;
    word-break: keep-all;
    text-align: right;
}

.sci-fi-divider {
    border-color: rgba(0, 255, 255, 0.1);
    margin: 24px 0;
}

/* 表格 */
.table-wrapper {
    width: 100%;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
}

.sci-fi-table {
    background: rgba(0, 0, 0, 0.2);
    min-width: 500px;
}

.sci-fi-table :deep(.el-table__header-wrapper) {
    background: rgba(0, 255, 255, 0.05);
}

.sci-fi-table :deep(.el-table th) {
    background: transparent;
    color: #00ffff;
    border-color: rgba(0, 255, 255, 0.1);
}

.sci-fi-table :deep(.el-table td) {
    border-color: rgba(255, 255, 255, 0.05);
}

.sci-fi-table :deep(.el-table--striped .el-table__body tr.el-table__row--striped) {
    background: rgba(0, 0, 0, 0.1);
}

/* 空状态 */
.empty-state {
    text-align: center;
    padding: 60px 20px;
    position: relative;
}

.scan-line {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent, rgba(0, 255, 255, 0.5), transparent);
    animation: scanMove 3s linear infinite;
}

@keyframes scanMove {
    0% {
        top: 0;
        opacity: 0;
    }

    10% {
        opacity: 1;
    }

    90% {
        opacity: 1;
    }

    100% {
        top: 100%;
        opacity: 0;
    }
}

.empty-icon {
    font-size: 48px;
    margin-bottom: 16px;
}

.empty-text {
    font-size: 16px;
    color: #64748b;
    margin: 0 0 8px 0;
    letter-spacing: 1px;
}

.empty-text.error {
    color: #f87171;
}

.empty-hint {
    font-size: 13px;
    color: #475569;
    margin: 0 0 24px 0;
    line-height: 1.5;
}

.sci-fi-reset-btn {
    background: rgba(139, 92, 246, 0.2);
    border: 1px solid #8b5cf6;
    color: #8b5cf6;
}

.sci-fi-reset-btn:hover {
    background: rgba(139, 92, 246, 0.3);
    color: #a78bfa;
}

/* ===================== Element Plus 组件深度样式覆盖 ===================== */
.sci-fi-form :deep(.el-form-item__label) {
    color: #7634b3;
    font-weight: 600;
    padding-bottom: 6px;
    line-height: 1.4;
}

.sci-fi-select :deep(.el-input__wrapper) {
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(0, 255, 255, 0.2);
    box-shadow: none;
}

.sci-fi-select :deep(.el-input__wrapper:hover) {
    border-color: rgba(0, 255, 255, 0.4);
}

.sci-fi-select :deep(.el-input__wrapper.is-focus) {
    border-color: #00ffff;
    box-shadow: 0 0 10px rgba(0, 255, 255, 0.2);
}

/* ===================== 移动端响应式适配 ===================== */
@media screen and (max-width: 768px) {
    .rocket-calculator {
        padding: 12px;
    }

    .sci-fi-title {
        font-size: 20px;
        letter-spacing: 2px;
        transform: scale(0.9);
        transform-origin: center;
        margin-left: -5%;
        margin-right: -5%;
    }

    .sci-fi-subtitle {
        font-size: 12px;
        letter-spacing: 1px;
    }

    .sci-fi-card :deep(.k-card__body) {
        padding: 16px;
    }

    .content-layout {
        grid-template-columns: 1fr;
        gap: 16px;
    }

    .key-stats {
        grid-template-columns: repeat(2, 1fr);
    }

    .key-stats .stat-item:last-child {
        grid-column: 1 / -1;
    }

    .modules-grid {
        grid-template-columns: 1fr;
    }

    .detail-grid {
        grid-template-columns: 1fr;
    }

    .distance-step-selector {
        grid-template-columns: repeat(3, 1fr);
    }

    .step-btn {
        padding: 10px 6px;
        font-size: 14px;
    }

    .distance-value {
        font-size: 18px;
    }

    .result-header {
        flex-direction: column;
        align-items: flex-start;
    }
}

@media screen and (max-width: 480px) {
    .sci-fi-title {
        font-size: 18px;
        transform: scale(0.85);
    }

    .distance-step-selector {
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
    }

    .step-btn {
        padding: 8px 4px;
        font-size: 12px;
    }

    .stat-value {
        font-size: 20px;
    }

    .detail-item {
        padding: 10px 12px;
    }
}

@media screen and (max-width: 375px) {
    .rocket-calculator {
        padding: 8px;
    }

    .sci-fi-title {
        font-size: 16px;
        letter-spacing: 1px;
        transform: scale(0.8);
    }

    .distance-input-wrapper {
        padding: 10px 8px;
    }

    .distance-label {
        font-size: 12px;
    }

    .distance-value {
        font-size: 16px;
    }

    .module-item {
        padding: 10px;
    }

}
</style>