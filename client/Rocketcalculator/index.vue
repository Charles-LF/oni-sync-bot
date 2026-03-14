<template>
    <k-layout>
        <el-scrollbar class="scrollbar">
            <k-slot name="calculator" />
        </el-scrollbar>
    </k-layout>
</template>

<style lang="css" scoped>
.scrollbar {
    background: linear-gradient(135deg, #0a0e27 0%, #1a1f3a 50%, #0f172a 100%);
    color: #e0e7ff;
}
</style>