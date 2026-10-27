<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { useCreateWizardStore } from '@/stores/createWizard'
import StepBasic from '@/components/wizard/StepBasic.vue'
import StepStyle from '@/components/wizard/StepStyle.vue'
import StepUpload from '@/components/wizard/StepUpload.vue'
import StepAnalyze from '@/components/wizard/StepAnalyze.vue'
import StepReview from '@/components/wizard/StepReview.vue'
import TenantAdminShell from '@/components/account/TenantAdminShell.vue'
import { pageRepo, projectRepo } from '@/services/storage/repositories'

const wizard = useCreateWizardStore()
const route = useRoute()
const router = useRouter()
const message = useMessage()
const creating = ref(false)
const initializeProjectId = ref('')

const canNext = computed(() => {
  switch (wizard.step) {
    case 1:
    case 2:
      return true
    case 3:
      return wizard.canAnalyze && !wizard.files.some((f) => f.status === 'parsing')
    default:
      return false
  }
})

const generateCount = computed(
  () => wizard.analysis?.pages.filter((p) => !p.groupOnly).length ?? 0,
)

async function onCreate() {
  const emptyProject = wizard.creationMode === 'empty'
  if (!emptyProject && !generateCount.value) {
    message.error('没有待生成的页面，无法创建')
    return
  }
  creating.value = true
  try {
    const id = await wizard.createProject(emptyProject, initializeProjectId.value || undefined)
    wizard.reset()
    void router.push(emptyProject ? { path: '/project/' + id } : { path: '/project/' + id, query: { autostart: '1' } })
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    creating.value = false
  }
}

onMounted(async () => {
  const projectId = typeof route.query.initialize === 'string' ? route.query.initialize : ''
  if (!projectId) return
  try {
    const [project, pages] = await Promise.all([
      projectRepo.get(projectId),
      pageRepo.listByProject(projectId),
    ])
    if (!project) throw new Error('空项目不存在或已被删除')
    if (pages.length) throw new Error('当前项目已有页面，不能重新执行项目初始化')
    wizard.reset()
    initializeProjectId.value = project.id
    wizard.projectName = project.name
    wizard.platform = project.platform
    wizard.presetId = project.styleSpec.presetId
    wizard.tokens = { ...project.styleSpec.tokens }
    wizard.layout = project.styleSpec.layout ?? 'auto'
    wizard.layoutNotes = project.styleSpec.layoutNotes ?? ''
    wizard.customStyleText = project.styleSpec.customStyleText ?? ''
    wizard.customNotes = project.styleSpec.customNotes ?? ''
    wizard.creationMode = 'document'
    wizard.step = 3
  } catch (error) {
    message.error(error instanceof Error ? error.message : '无法继续初始化空项目')
    void router.replace('/')
  }
})
</script>

<template>
  <TenantAdminShell active="projects" title="创建项目" description="按照步骤配置项目信息、设计风格和需求文档。">
    <template #actions>
      <n-button secondary @click="router.push('/')">返回项目列表</n-button>
    </template>
  <div class="wizard-page">
    <n-steps :current="wizard.step" size="small" class="steps">
      <n-step title="基本信息" />
      <n-step title="设计风格" />
      <n-step title="文档或空项目" />
      <n-step title="需求理解" />
      <n-step title="清单审核" />
    </n-steps>

    <div class="step-body">
      <StepBasic v-if="wizard.step === 1" />
      <StepStyle v-else-if="wizard.step === 2" />
      <StepUpload v-else-if="wizard.step === 3" :allow-empty="!initializeProjectId" />
      <StepAnalyze v-else-if="wizard.step === 4" />
      <StepReview v-else-if="wizard.step === 5" />
    </div>

    <div class="wizard-footer">
      <n-button v-if="wizard.step > 1" :disabled="wizard.analyzing" @click="wizard.step--">
        上一步
      </n-button>
      <div style="flex: 1" />
      <n-button v-if="wizard.step < 3" type="primary" :disabled="!canNext" @click="wizard.step++">
        下一步
      </n-button>
      <n-button
        v-if="wizard.step === 3 && wizard.creationMode === 'document'"
        type="primary"
        :disabled="!canNext"
        @click="wizard.step++"
      >
        下一步
      </n-button>
      <n-button
        v-if="wizard.step === 3 && wizard.creationMode === 'empty'"
        type="primary"
        :loading="creating"
        :disabled="!wizard.projectName.trim()"
        @click="onCreate"
      >
        创建空项目
      </n-button>
      <n-button
        v-if="wizard.step === 5"
        type="primary"
        :loading="creating"
        :disabled="!generateCount"
        @click="onCreate"
      >
        创建项目并开始生成
      </n-button>
    </div>
  </div>
  </TenantAdminShell>
</template>

<style scoped>
.wizard-page {
  max-width: 980px;
  margin: 0;
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.steps {
  margin: 20px 0 28px;
}

.step-body {
  flex: 1;
}

.wizard-footer {
  display: flex;
  gap: 12px;
  padding: 20px 0 8px;
  margin-top: 16px;
  border-top: 1px solid var(--qp-border);
}
</style>
