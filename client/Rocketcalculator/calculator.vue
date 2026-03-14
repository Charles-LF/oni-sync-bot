<template>
    <k-layout class="rocket-calculator-wrapper">
        <el-scrollbar>

            <div class="rocket-calculator sci-fi-bg">
                <!-- 背景装饰网格 -->
                <div class="grid-overlay"></div>

                <k-card class="header-card sci-fi-card">
                    <div class="header-glow"></div>
                    <h1 class="sci-fi-title">ONI ROCKET CALCULATOR</h1>
                    <p class="sci-fi-subtitle">缺氧火箭最优配置解算系统 · 基于官方物理引擎</p>
                    <div class="content-layout">
                        <!-- 输入控制台（单列上半部分） -->
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
                                            <el-input-number v-model="form[key]" :min="0" :max="20"
                                                class="module-input" />
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
                        <!-- 结果显示面板（单列下半部分） -->
                        <k-card ref="resultCardRef" class="result-card sci-fi-card">
                            <div class="card-header-line"></div>
                            <template v-if="!result">
                                <div class="empty-state">
                                    <div class="scan-line"></div>
                                    <div class="empty-icon">📡</div>
                                    <p class="empty-text">等待输入参数...</p>
                                    <p class="empty-hint">请在上方配置核心参数与载荷</p>
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
            </div>
        </el-scrollbar>
    </k-layout>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed, nextTick } from "vue";
import { ref, reactive, onMounted, onUnmounted, computed, nextTick } from "vue";
import { ElMessage } from "element-plus";
import { calculateRocket } from "./calculator";
import { MODULE_LABELS, CalculatorInput, RocketSolution } from "./config";

// 结果面板Ref
const resultCardRef = ref();

// 移动端适配核心逻辑
// 滚动容器与结果面板Ref，修复滚动错位
const scrollBarRef = ref();
const resultCardRef = ref();

// 移动端适配核心逻辑修复
const isMobile = ref(false);
const MOBILE_BREAKPOINT = 768;
let resizeTimer: number | null = null;

const checkIsMobile = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
        isMobile.value = window.innerWidth <= MOBILE_BREAKPOINT;
    }, 100);
};

const distanceOptions = computed(() => {
    const options = [];
    for (let i = 10000; i <= 190000; i += 10000) {
        options.push(i);
    }
    return options;
});

onMounted(() => {
    checkIsMobile(); // 初始化立即执行
    window.addEventListener("resize", checkIsMobile);
});


onUnmounted(() => {
    window.removeEventListener("resize", checkIsMobile);
    if (resizeTimer) clearTimeout(resizeTimer);
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
            nextTick(() => {
                if (isMobile.value && resultCardRef.value) {
                    const targetElement = resultCardRef.value.$el;
                    if (targetElement) {
                        window.scrollTo({
                            top: targetElement.offsetTop - 20,
                            behavior: "smooth"
                        });
                    }
                }
            });
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
    nextTick(() => {
        window.scrollTo({
            top: 0,
            behavior: "smooth"
        });
    });
};
</script>


<style lang="css" scoped>
/* 全局盒模型修复 */
:deep(*),
* {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
    margin: 0;
    padding: 0;
}

/* ===================== k-layout 根容器适配 ===================== */
.rocket-calculator-wrapper {
    width: 100%;
    max-width: 100vw;
    min-height: 100vh;
    overflow-x: hidden;
}

.rocket-calculator-wrapper:deep(.k-layout),
.rocket-calculator-wrapper:deep(.k-layout__content),
:deep(.layout-container),
:deep(.main-container),
:deep(.layout-main) {
    width: 100%;
    max-width: 100vw;
    overflow-x: hidden;
    flex-shrink: 0;
}

/* ===================== 核心内容容器 ===================== */
.rocket-calculator {
    width: 100%;
    max-width: 100%;
    width: 100%;
    max-width: 100%;
    margin: 0 auto;
    padding: 16px;
    padding: 16px;
    box-sizing: border-box;
    position: relative;
    min-height: 100vh;
    overflow-x: hidden;
}

/* 深空背景 */
.sci-fi-bg {
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

/* 禁止滚动容器横向滚动，彻底解决溢出错位 */
:deep(.el-scrollbar__wrap) {
    overflow-x: hidden !important;
}

:deep(.el-scrollbar__view) {
    width: 100%;
    overflow-x: hidden !important;
}

/* 科幻卡片 */
.sci-fi-card {
    width: 100%;
    width: 100%;
    background: rgba(15, 23, 42, 0.95);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(0, 255, 255, 0.2);
    box-shadow:
        0 0 20px rgba(0, 255, 255, 0.1),
        inset 0 0 20px rgba(0, 0, 0, 0.5);
    position: relative;
    overflow: visible;
    z-index: 1;
    box-sizing: border-box;
    box-sizing: border-box;
}

.sci-fi-card :deep(.k-card__body) {
    padding: 20px 16px;
    width: 100%;
    box-sizing: border-box;
    padding: 20px 16px;
    width: 100%;
    box-sizing: border-box;
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
    margin-bottom: 20px;
    margin-bottom: 20px;
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
    font-size: 24px;
    font-size: 24px;
    font-weight: 800;
    letter-spacing: 2px;
    letter-spacing: 2px;
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
    word-wrap: break-word;
    white-space: normal;
    word-wrap: break-word;
    white-space: normal;
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
    color: #94a3b8;
    color: #94a3b8;
    font-size: 13px;
    letter-spacing: 1px;
    word-wrap: break-word;
    letter-spacing: 1px;
    word-wrap: break-word;
}

/* ===================== 内容布局 ===================== */
.content-layout {
    display: grid;
    grid-template-columns: 1fr;
    gap: 20px;
    margin-top: 20px;
    width: 100%;
    grid-template-columns: 1fr;
    gap: 20px;
    margin-top: 20px;
    width: 100%;
}

/* ===================== 表单样式 ===================== */
.config-section {
    margin-bottom: 20px;
}

.section-title {
    margin: 0 0 16px 0;
    margin: 0 0 16px 0;
    color: #00ffff;
    font-size: 16px;
    font-size: 16px;
    letter-spacing: 2px;
    border-left: 3px solid #00ffff;
    padding-left: 12px;
    border-left: 3px solid #00ffff;
    padding-left: 12px;
}

/* 距离选择器 */
/* 距离选择器 */
.distance-control {
    width: 100%;
}

.distance-step-selector {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 12px;
    width: 100%;
    margin-bottom: 12px;
    width: 100%;
}

/* ===================== 核心修复：按钮偏移彻底解决 ===================== */
.step-btn {
    min-width: 0;
    width: 100%;
    height: 36px;
    padding: 0 4px;
    margin: 0;
    /* 强制移除Element Plus默认margin */
    border: 1px solid rgba(0, 255, 255, 0.3);
    background: rgba(15, 23, 42, 0.8);
    color: #94a3b8;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.3s ease;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.3s ease;
    font-size: 12px;
    box-sizing: border-box;
    word-break: keep-all;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}

.step-btn:hover {
    border-color: #00ffff;
    border-color: #00ffff;
    color: #00ffff;
    box-shadow: 0 0 10px rgba(0, 255, 255, 0.2);
    box-shadow: 0 0 10px rgba(0, 255, 255, 0.2);
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
    border-radius: 6px;
    border: 1px solid rgba(0, 255, 255, 0.15);
    width: 100%;
    box-sizing: border-box;
    flex-wrap: wrap;
    border-radius: 6px;
    border: 1px solid rgba(0, 255, 255, 0.15);
    width: 100%;
    box-sizing: border-box;
    flex-wrap: wrap;
}

.distance-label {
    color: #94a3b8;
    font-size: 14px;
    color: #94a3b8;
    font-size: 14px;
}

.distance-value {
    color: #00ffff;
    color: #00ffff;
    font-size: 20px;
    font-weight: 700;
    font-family: 'Courier New', monospace;
    font-weight: 700;
    font-family: 'Courier New', monospace;
}

.unit {
    color: #94a3b8;
    color: #94a3b8;
    font-size: 14px;
}

/* 氧化剂提示 */
.oxidizer-hint {
    display: flex;
    justify-content: space-between;
    margin-top: 8px;
    padding: 0 8px;
}

.hint-item {
    font-size: 12px;
    color: #64748b;
    transition: all 0.3s ease;
}

.hint-item.active {
    color: #00ffff;
    text-shadow: 0 0 8px rgba(0, 255, 255, 0.5);
}

/* 氧化剂提示 */
.oxidizer-hint {
    display: flex;
    justify-content: space-between;
    margin-top: 8px;
    padding: 0 8px;
}

.hint-item {
    font-size: 12px;
    color: #64748b;
    transition: all 0.3s ease;
}

.hint-item.active {
    color: #00ffff;
    text-shadow: 0 0 8px rgba(0, 255, 255, 0.5);
}

/* 模块网格 */
.modules-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    margin-bottom: 20px;
    width: 100%;
    margin-bottom: 20px;
    width: 100%;
}

.module-item {
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(0, 255, 255, 0.15);
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(0, 255, 255, 0.15);
    border-radius: 6px;
    padding: 12px;
    transition: all 0.3s ease;
    width: 100%;
    box-sizing: border-box;
    width: 100%;
    box-sizing: border-box;
}

.module-item:hover {
    border-color: rgba(0, 255, 255, 0.4);
    box-shadow: 0 0 10px rgba(0, 255, 255, 0.1);
    border-color: rgba(0, 255, 255, 0.4);
    box-shadow: 0 0 10px rgba(0, 255, 255, 0.1);
}

.module-header {
    margin-bottom: 8px;
    margin-bottom: 8px;
}

.module-name {
    color: #e0e7ff;
    color: #e0e7ff;
    font-size: 13px;
    word-wrap: break-word;
    word-wrap: break-word;
}

.module-input {
    width: 100%;
}

/* 解算按钮 */
/* 解算按钮 */
.calculate-btn-wrapper {
    margin-top: 20px;
    margin-top: 20px;
}

.sci-fi-calculate-btn {
    width: 100%;
    height: 50px;
    margin: 0;
    /* 移除默认margin */
    background: linear-gradient(90deg, #00ffff, #8b5cf6);
    border: none;
    color: #0f172a;
    color: #0f172a;
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 4px;
    font-weight: 700;
    letter-spacing: 4px;
    position: relative;
    overflow: hidden;
    transition: all 0.3s ease;
}

.sci-fi-calculate-btn:hover {
    transform: translateY(-2px);
    box-shadow: 0 0 30px rgba(0, 255, 255, 0.5);
    box-shadow: 0 0 30px rgba(0, 255, 255, 0.5);
}

.sci-fi-calculate-btn:active {
    transform: translateY(0);

    .sci-fi-calculate-btn:active {
        transform: translateY(0);
    }

    .btn-glow {
        position: absolute;
        top: 0;
        left: -100%;
        width: 100%;
        height: 100%;
        background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.4), transparent);
        transition: all 0.6s ease;
        transition: all 0.6s ease;
    }

    .sci-fi-calculate-btn:hover .btn-glow {
        left: 100%;
    }

    /* 分割线 */
    .divider-line {
        height: 1px;
        background: linear-gradient(90deg, transparent, rgba(0, 255, 255, 0.3), transparent);
        margin: 24px 0;
    }

    .sci-fi-calculate-btn:hover .btn-glow {
        left: 100%;
    }

    /* 分割线 */
    .divider-line {
        height: 1px;
        background: linear-gradient(90deg, transparent, rgba(0, 255, 255, 0.3), transparent);
        margin: 24px 0;
    }

    /* ===================== 结果面板样式 ===================== */
    .empty-state {
        text-align: center;
        padding: 60px 20px;
        position: relative;

        /* ===================== 结果面板样式 ===================== */
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            position: relative;
            width: 100%;
            box-sizing: border-box;
            box-sizing: border-box;
        }

        .scan-line {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 2px;
            background: linear-gradient(90deg, transparent, #00ffff, transparent);
            animation: scanDown 2s ease-in-out infinite;
        }

        @keyframes scanDown {
            0% {
                top: 0;
                opacity: 0;
            }

            50% {
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

            .scan-line {
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                height: 2px;
                background: linear-gradient(90deg, transparent, #00ffff, transparent);
                animation: scanDown 2s ease-in-out infinite;
            }

            @keyframes scanDown {
                0% {
                    top: 0;
                    opacity: 0;
                }

                50% {
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
                color: #94a3b8;
                font-size: 18px;
                margin: 0 0 8px 0;

                .empty-text {
                    color: #94a3b8;
                    font-size: 18px;
                    margin: 0 0 8px 0;
                }

                .empty-text.error {
                    color: #f87171;
                }

                .empty-hint {
                    .empty-text.error {
                        color: #f87171;
                    }

                    .empty-hint {
                        color: #64748b;
                        font-size: 14px;
                        margin: 0;
                        font-size: 14px;
                        margin: 0;
                    }

                    .sci-fi-reset-btn {
                        margin-top: 20px;
                        margin-left: 0;
                        /* 移除默认margin */
                        border-color: #00ffff;
                        color: #00ffff;
                        background: transparent;
                    }

                    .sci-fi-reset-btn:hover {
                        background: rgba(0, 255, 255, 0.1);
                        box-shadow: 0 0 15px rgba(0, 255, 255, 0.3);
                        background: transparent;
                    }

                    .sci-fi-reset-btn:hover {
                        background: rgba(0, 255, 255, 0.1);
                        box-shadow: 0 0 15px rgba(0, 255, 255, 0.3);
                    }

                    /* 结果头部 */
                    /* 结果头部 */
                    .result-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 20px;
                        margin-bottom: 20px;
                        flex-wrap: wrap;
                        gap: 8px;
                    }

                    .result-title {
                        margin: 0;
                        color: #00ffff;
                        font-size: 18px;
                        font-size: 18px;
                        letter-spacing: 2px;
                    }

                    .result-status {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        color: #10b981;
                        gap: 6px;
                        color: #10b981;
                        font-size: 12px;
                        font-weight: 700;
                        font-weight: 700;
                        letter-spacing: 1px;
                    }

                    .status-dot {
                        width: 8px;
                        height: 8px;
                        border-radius: 50%;
                        background: #10b981;
                        animation: pulse 2s ease-in-out infinite;
                        background: #10b981;
                        animation: pulse 2s ease-in-out infinite;
                    }

                    @keyframes pulse {
                        @keyframes pulse {

                            0%,
                            100% {
                                opacity: 1;
                                opacity: 1;
                            }

                            50% {
                                opacity: 0.3;
                                opacity: 0.3;
                            }
                        }

                        /* 核心统计 */
                        /* 核心统计 */
                        .key-stats {
                            display: grid;
                            grid-template-columns: repeat(3, 1fr);
                            gap: 12px;
                            margin-bottom: 20px;
                            width: 100%;
                            gap: 12px;
                            margin-bottom: 20px;
                            width: 100%;
                        }

                        .stat-item {
                            background: rgba(0, 0, 0, 0.3);
                            border: 1px solid rgba(0, 255, 255, 0.2);
                            border-radius: 8px;
                            padding: 12px;
                            border: 1px solid rgba(0, 255, 255, 0.2);
                            border-radius: 8px;
                            padding: 12px;
                            text-align: center;
                            width: 100%;
                            box-sizing: border-box;
                            width: 100%;
                            box-sizing: border-box;
                        }

                        .stat-item.primary {
                            border-color: #8b5cf6;
                            box-shadow: 0 0 15px rgba(139, 92, 246, 0.2);
                            border-color: #8b5cf6;
                            box-shadow: 0 0 15px rgba(139, 92, 246, 0.2);
                        }

                        .stat-item.success {
                            border-color: #10b981;
                            box-shadow: 0 0 15px rgba(16, 185, 129, 0.2);
                            border-color: #10b981;
                            box-shadow: 0 0 15px rgba(16, 185, 129, 0.2);
                        }

                        .stat-item.warning {
                            border-color: #f59e0b;
                            box-shadow: 0 0 15px rgba(245, 158, 11, 0.2);
                            border-color: #f59e0b;
                            box-shadow: 0 0 15px rgba(245, 158, 11, 0.2);
                        }

                        .stat-label {
                            color: #94a3b8;
                            font-size: 11px;
                            margin-bottom: 6px;
                            color: #94a3b8;
                            font-size: 11px;
                            margin-bottom: 6px;
                            letter-spacing: 1px;
                            word-wrap: break-word;
                            word-wrap: break-word;
                        }

                        .stat-value {
                            color: #e0e7ff;
                            font-size: 18px;
                            font-weight: 700;
                            font-family: 'Courier New', monospace;
                            word-wrap: break-word;
                            color: #e0e7ff;
                            font-size: 18px;
                            font-weight: 700;
                            font-family: 'Courier New', monospace;
                            word-wrap: break-word;
                        }

                        .stat-unit {
                            font-size: 12px;
                            color: #94a3b8;
                            font-weight: 400;
                            font-size: 12px;
                            color: #94a3b8;
                            font-weight: 400;
                        }

                        /* 详情统计 */
                        /* 详情统计 */
                        .detail-title {
                            margin: 0 0 16px 0;
                            color: #00ffff;
                            color: #00ffff;
                            font-size: 14px;
                            letter-spacing: 2px;
                        }

                        .detail-grid {
                            display: grid;
                            grid-template-columns: repeat(2, 1fr);
                            gap: 12px;
                            width: 100%;
                            width: 100%;
                        }

                        .detail-item {
                            display: flex;
                            justify-content: space-between;
                            align-items: center;
                            padding: 10px 12px;
                            padding: 10px 12px;
                            background: rgba(0, 0, 0, 0.2);
                            border-radius: 4px;
                            border: 1px solid rgba(0, 255, 255, 0.1);
                            width: 100%;
                            box-sizing: border-box;
                            flex-wrap: wrap;
                            gap: 4px;
                            border-radius: 4px;
                            border: 1px solid rgba(0, 255, 255, 0.1);
                            width: 100%;
                            box-sizing: border-box;
                            flex-wrap: wrap;
                            gap: 4px;
                        }

                        .detail-label {
                            color: #94a3b8;
                            font-size: 13px;
                            font-size: 13px;
                        }

                        .detail-value {
                            color: #e0e7ff;
                            font-weight: 700;
                            font-family: 'Courier New', monospace;
                            word-break: break-all;
                            font-weight: 700;
                            font-family: 'Courier New', monospace;
                            word-break: break-all;
                        }

                        /* 分割线 */
                        /* 分割线 */
                        .sci-fi-divider {
                            border-color: rgba(0, 255, 255, 0.2);
                            margin: 20px 0;
                            border-color: rgba(0, 255, 255, 0.2);
                            margin: 20px 0;
                        }

                        /* 表格适配修复 */
                        /* 表格适配修复 */
                        .table-wrapper {
                            overflow-x: auto;
                            width: 100%;
                            box-sizing: border-box;
                            width: 100%;
                            box-sizing: border-box;
                        }

                        .sci-fi-table {
                            width: 100%;
                            width: 100%;
                            min-width: 500px;
                            background: transparent;
                            background: transparent;
                        }

                        .sci-fi-table :deep(.el-table__header) {
                            background: rgba(0, 0, 0, 0.3);

                            .sci-fi-table :deep(.el-table__header) {
                                background: rgba(0, 0, 0, 0.3);
                            }

                            .sci-fi-table :deep(.el-table__header th) {
                                .sci-fi-table :deep(.el-table__header th) {
                                    background: transparent;
                                    color: #00ffff;
                                    border-bottom: 1px solid rgba(0, 255, 255, 0.2);
                                    border-bottom: 1px solid rgba(0, 255, 255, 0.2);
                                }

                                .sci-fi-table :deep(.el-table__body tr) {
                                    background: transparent;

                                    .sci-fi-table :deep(.el-table__body tr) {
                                        background: transparent;
                                    }

                                    .sci-fi-table :deep(.el-table__body tr:hover>td) {
                                        background: rgba(0, 255, 255, 0.05);

                                        .sci-fi-table :deep(.el-table__body tr:hover>td) {
                                            background: rgba(0, 255, 255, 0.05);
                                        }

                                        .sci-fi-table :deep(.el-table__body td) {
                                            border-bottom: 1px solid rgba(0, 255, 255, 0.1);
                                            color: #e0e7ff;

                                            .sci-fi-table :deep(.el-table__body td) {
                                                border-bottom: 1px solid rgba(0, 255, 255, 0.1);
                                                color: #e0e7ff;
                                            }

                                            /* ===================== Element Plus 组件深度覆盖 ===================== */
                                            .sci-fi-form :deep(.el-form-item__label) {
                                                color: #e0e7ff;
                                                padding-bottom: 4px;
                                            }

                                            .sci-fi-select :deep(.el-select__wrapper) {
                                                background: rgba(0, 0, 0, 0.3);
                                                border-color: rgba(0, 255, 255, 0.3);
                                                color: #e0e7ff;

                                                /* ===================== Element Plus 组件深度覆盖 ===================== */
                                                .sci-fi-form :deep(.el-form-item__label) {
                                                    color: #e0e7ff;
                                                    padding-bottom: 4px;
                                                }

                                                .sci-fi-select :deep(.el-select__wrapper) {
                                                    background: rgba(0, 0, 0, 0.3);
                                                    border-color: rgba(0, 255, 255, 0.3);
                                                    color: #e0e7ff;
                                                }

                                                .sci-fi-select :deep(.el-select__wrapper:hover) {
                                                    border-color: #00ffff;

                                                    .sci-fi-select :deep(.el-select__wrapper:hover) {
                                                        border-color: #00ffff;
                                                    }

                                                    .sci-fi-radio-group :deep(.el-radio-button__inner) {
                                                        background: rgba(0, 0, 0, 0.3);
                                                        border-color: rgba(0, 255, 255, 0.3);
                                                        color: #94a3b8;

                                                        .sci-fi-radio-group :deep(.el-radio-button__inner) {
                                                            background: rgba(0, 0, 0, 0.3);
                                                            border-color: rgba(0, 255, 255, 0.3);
                                                            color: #94a3b8;
                                                        }

                                                        .sci-fi-radio-group :deep(.el-radio-button__inner:hover) {
                                                            color: #00ffff;

                                                            .sci-fi-radio-group :deep(.el-radio-button__inner:hover) {
                                                                color: #00ffff;
                                                            }

                                                            .sci-fi-radio-group :deep(.is-active .el-radio-button__inner) {
                                                                background: rgba(0, 255, 255, 0.15);
                                                                border-color: #00ffff;
                                                                color: #00ffff;
                                                                box-shadow: 0 0 10px rgba(0, 255, 255, 0.2);

                                                                .sci-fi-radio-group :deep(.is-active .el-radio-button__inner) {
                                                                    background: rgba(0, 255, 255, 0.15);
                                                                    border-color: #00ffff;
                                                                    color: #00ffff;
                                                                    box-shadow: 0 0 10px rgba(0, 255, 255, 0.2);
                                                                }

                                                                .module-input :deep(.el-input-number__decrease),
                                                                .module-input :deep(.el-input-number__increase) {
                                                                    background: rgba(0, 0, 0, 0.3);
                                                                    border-color: rgba(0, 255, 255, 0.3);
                                                                    color: #94a3b8;

                                                                    .module-input :deep(.el-input-number__decrease),
                                                                    .module-input :deep(.el-input-number__increase) {
                                                                        background: rgba(0, 0, 0, 0.3);
                                                                        border-color: rgba(0, 255, 255, 0.3);
                                                                        color: #94a3b8;
                                                                    }

                                                                    .module-input :deep(.el-input-number__decrease:hover),
                                                                    .module-input :deep(.el-input-number__increase:hover) {
                                                                        color: #00ffff;
                                                                        border-color: #00ffff;

                                                                        .module-input :deep(.el-input-number__decrease:hover),
                                                                        .module-input :deep(.el-input-number__increase:hover) {
                                                                            color: #00ffff;
                                                                            border-color: #00ffff;
                                                                        }

                                                                        .module-input :deep(.el-input__wrapper) {
                                                                            .module-input :deep(.el-input__wrapper) {
                                                                                background: rgba(0, 0, 0, 0.3);
                                                                                border-color: rgba(0, 255, 255, 0.3);
                                                                                border-color: rgba(0, 255, 255, 0.3);
                                                                                box-shadow: none;
                                                                            }

                                                                            .module-input :deep(.el-input__wrapper:hover) {
                                                                                border-color: #00ffff;

                                                                                .module-input :deep(.el-input__wrapper:hover) {
                                                                                    border-color: #00ffff;
                                                                                }

                                                                                .module-input :deep(.el-input__inner) {
                                                                                    color: #e0e7ff;

                                                                                    .module-input :deep(.el-input__inner) {
                                                                                        color: #e0e7ff;
                                                                                    }

                                                                                    /* ===================== 移动端响应式优化 ===================== */
                                                                                    @media (max-width: 768px) {

                                                                                        /* ===================== 移动端响应式优化 ===================== */
                                                                                        @media (max-width: 768px) {
                                                                                            .rocket-calculator {
                                                                                                padding: 12px 8px;
                                                                                                padding: 12px 8px;
                                                                                            }

                                                                                            .sci-fi-title {
                                                                                                font-size: 20px;
                                                                                                letter-spacing: 1px;
                                                                                                letter-spacing: 1px;
                                                                                            }

                                                                                            .sci-fi-subtitle {
                                                                                                font-size: 12px;
                                                                                            }

                                                                                            .distance-step-selector {
                                                                                                grid-template-columns: repeat(3, minmax(0, 1fr));

                                                                                                .distance-step-selector {
                                                                                                    grid-template-columns: repeat(3, minmax(0, 1fr));
                                                                                                }

                                                                                                .modules-grid {
                                                                                                    .modules-grid {
                                                                                                        grid-template-columns: 1fr;
                                                                                                    }

                                                                                                    .key-stats {
                                                                                                        grid-template-columns: 1fr;
                                                                                                    }

                                                                                                    .detail-grid {
                                                                                                        grid-template-columns: 1fr;
                                                                                                    }

                                                                                                    .result-header {
                                                                                                        flex-direction: column;
                                                                                                        align-items: flex-start;
                                                                                                    }

                                                                                                    .sci-fi-card :deep(.k-card__body) {
                                                                                                        padding: 16px 12px;
                                                                                                    }

                                                                                                    .sci-fi-card :deep(.k-card__body) {
                                                                                                        padding: 16px 12px;
                                                                                                    }

                                                                                                    .distance-value {
                                                                                                        .distance-value {
                                                                                                            font-size: 18px;
                                                                                                        }

                                                                                                        .sci-fi-form :deep(.el-form-item) {
                                                                                                            margin-bottom: 16px;
                                                                                                        }

                                                                                                        .sci-fi-form :deep(.el-form-item) {
                                                                                                            margin-bottom: 16px;
                                                                                                        }

                                                                                                        .sci-fi-select :deep(.el-select__wrapper),
                                                                                                        .module-input :deep(.el-input__wrapper) {
                                                                                                            height: 40px;

                                                                                                            .sci-fi-select :deep(.el-select__wrapper),
                                                                                                            .module-input :deep(.el-input__wrapper) {
                                                                                                                height: 40px;
                                                                                                            }

                                                                                                            .module-input :deep(.el-input-number) {
                                                                                                                width: 100%;

                                                                                                                .module-input :deep(.el-input-number) {
                                                                                                                    width: 100%;
                                                                                                                }
                                                                                                            }

                                                                                                            /* 超小屏幕适配 */
                                                                                                            @media (max-width: 375px) {
                                                                                                                .distance-step-selector {
                                                                                                                    grid-template-columns: repeat(2, minmax(0, 1fr));

                                                                                                                    /* 超小屏幕适配 */
                                                                                                                    @media (max-width: 375px) {
                                                                                                                        .distance-step-selector {
                                                                                                                            grid-template-columns: repeat(2, minmax(0, 1fr));
                                                                                                                        }

                                                                                                                        .stat-value {
                                                                                                                            .stat-value {
                                                                                                                                font-size: 16px;
                                                                                                                            }

                                                                                                                            .sci-fi-title {
                                                                                                                                font-size: 18px;

                                                                                                                                .sci-fi-title {
                                                                                                                                    font-size: 18px;
                                                                                                                                }

                                                                                                                                .step-btn {
                                                                                                                                    height: 32px;
                                                                                                                                    font-size: 11px;

                                                                                                                                    .step-btn {
                                                                                                                                        height: 32px;
                                                                                                                                        font-size: 11px;
                                                                                                                                    }
                                                                                                                                }</style>