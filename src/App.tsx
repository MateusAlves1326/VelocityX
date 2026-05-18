import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import * as XLSX from 'xlsx'
import './App.css'

type SpeedResult = {
  pingMs: number
  downloadMbps: number
  uploadMbps: number
  totalMbps: number
  pingSamples: number[]
  downloadSamples: number[]
  uploadSamples: number[]
  stabilityLabel: string
  stabilityVariation: number
}

type HistoryEntry = {
  id: string
  testedAt: string
  pingMs: number
  downloadMbps: number
  uploadMbps: number
  totalMbps: number
  stabilityLabel: string
  stabilityVariation: number
  planInput: string
  planMbps: number | null
  adequacyPercent: number | null
}

type CloudflareMeta = {
  ip: string | null
  colo: string | null
}

const CF_BASE = 'https://speed.cloudflare.com'
const HISTORY_STORAGE_KEY = 'speedtest-history-v1'
const SCHEDULE_STORAGE_KEY = 'speedtest-schedule-v1'
const SPEEDOMETER_MAX_MBPS = 1000

type PersistedSchedule = {
  enabled: boolean
  startAt: number
  endAt: number
  nextRunAt: number | null
  scheduledRuns: number
  intervalMs: number
}

const readHistoryFromStorage = (): HistoryEntry[] => {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY)
    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed as HistoryEntry[]
  } catch {
    return []
  }
}

const readScheduleFromStorage = (): PersistedSchedule | null => {
  try {
    const raw = localStorage.getItem(SCHEDULE_STORAGE_KEY)
    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as Partial<PersistedSchedule>
    if (
      typeof parsed.enabled !== 'boolean' ||
      typeof parsed.startAt !== 'number' ||
      typeof parsed.endAt !== 'number' ||
      typeof parsed.scheduledRuns !== 'number' ||
      typeof parsed.intervalMs !== 'number'
    ) {
      return null
    }

    if (parsed.nextRunAt !== null && typeof parsed.nextRunAt !== 'number') {
      return null
    }

    return {
      enabled: parsed.enabled,
      startAt: parsed.startAt,
      endAt: parsed.endAt,
      nextRunAt: parsed.nextRunAt ?? null,
      scheduledRuns: parsed.scheduledRuns,
      intervalMs: parsed.intervalMs,
    }
  } catch {
    return null
  }
}

const formatDateTime = (isoDate: string) =>
  new Date(isoDate).toLocaleString('pt-BR')

const formatTimestamp = (timestamp: number) =>
  new Date(timestamp).toLocaleString('pt-BR')

// Extrai pares chave=valor retornados pelo endpoint /cdn-cgi/trace.
const parseTraceResponse = (raw: string): CloudflareMeta => {
  const result: CloudflareMeta = {
    ip: null,
    colo: null,
  }

  for (const line of raw.split('\n')) {
    const [key, value] = line.split('=')
    if (!key || !value) {
      continue
    }

    if (key === 'ip') {
      result.ip = value.trim()
    }

    if (key === 'colo') {
      result.colo = value.trim()
    }
  }

  return result
}

// Formata numeros com uma casa decimal para exibir resultados no painel.
const formatNumber = (value: number) => value.toFixed(1)
// Aguarda um intervalo para cadenciar etapas visuais e de medicao.
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Converte a entrada do plano (ex.: 1gb, 500mb) para Mbps.
const parsePlanToMbps = (raw: string): number | null => {
  const normalized = raw.trim().toLowerCase().replace(',', '.')
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(g|gb|giga|m|mb|mega)?$/)

  if (!match) {
    return null
  }

  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) {
    return null
  }

  const unit = match[2]
  if (!unit || unit.startsWith('m')) {
    return amount
  }

  return amount * 1000
}

// Calcula a media aritmetica simples de um conjunto de valores.
const average = (values: number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length

// Calcula a media descartando extremos para reduzir impacto de outliers.
const trimmedAverage = (values: number[], trimRatio = 0.2) => {
  if (values.length <= 2) {
    return average(values)
  }

  const sorted = [...values].sort((a, b) => a - b)
  const trimCount = Math.min(
    Math.floor(sorted.length * trimRatio),
    Math.floor((sorted.length - 1) / 2),
  )
  const trimmed = sorted.slice(trimCount, sorted.length - trimCount)
  return average(trimmed)
}

// Calcula o desvio padrao para medir variacao entre amostras.
const stdDev = (values: number[]) => {
  const avg = average(values)
  const variance =
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

// Classifica a estabilidade da conexao a partir da variacao percentual.
const getStability = (samples: number[]) => {
  const avg = average(samples)
  const variation = avg > 0 ? (stdDev(samples) / avg) * 100 : 0

  if (variation <= 8) {
    return { label: 'Estavel', variation }
  }

  if (variation <= 16) {
    return { label: 'Moderada', variation }
  }

  return { label: 'Instavel', variation }
}

// Gera payload aleatorio para upload respeitando limite da Web Crypto API.
const createRandomPayload = (size: number) => {
  const payload = new Uint8Array(size)

  // Browsers limit each getRandomValues call to 65,536 bytes.
  for (let offset = 0; offset < payload.length; offset += 65_536) {
    const end = Math.min(offset + 65_536, payload.length)
    crypto.getRandomValues(payload.subarray(offset, end))
  }

  return payload
}

// Mede throughput por tempo com workers paralelos e coleta amostras periodicas.
const measureTimedThroughput = async ({
  mode,
  durationMs,
  workers,
  chunkBytes,
  onProgress,
  onSpeedUpdate,
}: {
  mode: 'download' | 'upload'
  durationMs: number
  workers: number
  chunkBytes: number
  onProgress: (ratio: number) => void
  onSpeedUpdate?: (mbps: number) => void
}) => {
  const start = performance.now()
  const endAt = start + durationMs
  let totalBytes = 0
  let lastSampleTime = start
  let lastSampleBytes = 0
  const samples: number[] = []

  const uploadPayloads =
    mode === 'upload'
      ? Array.from({ length: workers }, () => createRandomPayload(chunkBytes))
      : []

  const samplingTimer = window.setInterval(() => {
    const now = performance.now()
    const elapsed = now - lastSampleTime

    if (elapsed >= 900) {
      const deltaBytes = totalBytes - lastSampleBytes
      const mbps = (deltaBytes * 8) / (elapsed / 1000) / 1_000_000
      if (Number.isFinite(mbps) && mbps > 0) {
        samples.push(mbps)
        // Chama callback com velocidade atual em Mbps.
        onSpeedUpdate?.(mbps)
      }
      lastSampleTime = now
      lastSampleBytes = totalBytes
    }

    const ratio = Math.min(1, (now - start) / durationMs)
    onProgress(ratio)
  }, 250)

  const workerTasks = Array.from({ length: workers }, async (_, workerId) => {
    let round = 0

    while (performance.now() < endAt) {
      if (mode === 'download') {
        const response = await fetch(
          `${CF_BASE}/__down?bytes=${chunkBytes}&seed=${Date.now()}-${workerId}-${round}`,
          {
            cache: 'no-store',
          },
        )

        if (!response.ok) {
          throw new Error('Falha ao medir o download.')
        }

        const data = await response.arrayBuffer()
        totalBytes += data.byteLength
      } else {
        const response = await fetch(`${CF_BASE}/__up`, {
          method: 'POST',
          body: uploadPayloads[workerId],
          cache: 'no-store',
        })

        if (!response.ok) {
          throw new Error('Falha ao medir o upload.')
        }

        await response.arrayBuffer()
        totalBytes += chunkBytes
      }

      round += 1
    }
  })

  await Promise.all(workerTasks)
  window.clearInterval(samplingTimer)
  onProgress(1)

  const elapsedSeconds = Math.max((performance.now() - start) / 1000, 0.001)
  const mbps = (totalBytes * 8) / elapsedSeconds / 1_000_000

  if (!samples.length) {
    samples.push(mbps)
  }

  return {
    mbps,
    samples,
  }
}

const TEST_STEPS = [
  'Preparando ambiente',
  'Aquecendo conexao',
  'Ping em varias amostras',
  'Download profundo',
  'Upload profundo',
  'Analisando estabilidade',
  'Validacao final',
  'Resultado final',
]

type MetricKind = 'download' | 'upload' | 'ping'

function MetricIcon({ kind }: { kind: MetricKind }) {
  const iconPathByKind: Record<MetricKind, string> = {
    download: '/Download.svg',
    upload: '/Upload.svg',
    ping: '/Ping.svg',
    
  }

  return <img src={iconPathByKind[kind]} className="metric-icon" alt="" aria-hidden="true" />
}

// Converte amostras numericas em pontos XY para desenhar a linha no SVG.
const buildLinePoints = (
  values: number[],
  width: number,
  height: number,
  padding: number,
) => {
  if (!values.length) {
    return ''
  }

  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = Math.max(max - min, 0.001)
  const chartWidth = width - padding * 2
  const chartHeight = height - padding * 2
  const stepX = values.length > 1 ? chartWidth / (values.length - 1) : 0

  return values
    .map((value, index) => {
      const x = padding + stepX * index
      const y = padding + chartHeight - ((value - min) / range) * chartHeight
      return `${x},${y}`
    })
    .join(' ')
}

// Exibe o progresso do teste como velocimetro semicircular.
function Speedometer({
  progress,
  activeStep,
  totalSteps,
  speedMbps,
  maxGaugeMbps,
}: {
  progress: number
  activeStep: number
  totalSteps: number
  speedMbps: number | null
  maxGaugeMbps: number
}) {
  const clampedProgress = Math.max(0, Math.min(100, progress))
  const currentSpeed = Math.max(0, speedMbps ?? 0)
  const clampedSpeed = Math.min(currentSpeed, maxGaugeMbps)
  const angle = -120 + (clampedSpeed / maxGaugeMbps) * 240
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const speedLabel =
    speedMbps === null
      ? '--'
      : speedMbps >= 1
        ? `${formatNumber(speedMbps)} Mbps`
        : `${formatNumber(speedMbps * 1_000)} kbps`

  return (
    <div className="speedometer" role="img" aria-label={`Velocidade atual ${speedLabel}`}>
      <div className="speedometer-dial">
        {ticks.map((ratio) => {
          const tickAngle = -120 + ratio * 240
          const labelValue = Math.round(maxGaugeMbps * ratio)

          return (
            <div
              key={`tick-${ratio}`}
              className="speedometer-tick"
              style={{ transform: `translateX(-50%) rotate(${tickAngle}deg)` }}
            >
              <span style={{ transform: `rotate(${-tickAngle}deg)` }}>{labelValue}</span>
            </div>
          )
        })}
        <span className="speedometer-needle" style={{ transform: `translateX(-50%) rotate(${angle}deg)` }}></span>
        <div className="speedometer-core"></div>
      </div>
      <div className="speedometer-readout">
        <strong>{speedLabel}</strong>
        <span>Escala 0 a {Math.round(maxGaugeMbps)} Mbps</span>
        <small>
          Etapa {Math.min(activeStep + 1, totalSteps)}/{totalSteps} • {Math.round(clampedProgress)}%
        </small>
      </div>
    </div>
  )
}

// Componente de grafico de linha com hover e tooltip em cada amostra.
function LineChart({
  title,
  unit,
  color,
  icon,
  values,
}: {
  title: string
  unit: string
  color: string
  icon: MetricKind
  values: number[]
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const width = 520
  const height = 180
  const padding = 18
  const points = buildLinePoints(values, width, height, padding)
  const min = values.length ? Math.min(...values) : 0
  const max = values.length ? Math.max(...values) : 0

  const min_val = Math.min(...values)
  const max_val = Math.max(...values)
  const range = Math.max(max_val - min_val, 0.001)
  const chartWidth = width - padding * 2
  const chartHeight = height - padding * 2
  const stepX = values.length > 1 ? chartWidth / (values.length - 1) : 0

  return (
    <article className="chart-card">
      <div className="chart-head">
        <h3>
          <MetricIcon kind={icon} />
          {title}
        </h3>
        <p>
          min {formatNumber(min)} {unit} | max {formatNumber(max)} {unit}
        </p>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="line-chart"
        role="img"
        aria-label={`${title} em grafico de linha`}
      >
        <line
          x1={padding}
          y1={height - padding}
          x2={width - padding}
          y2={height - padding}
          className="axis"
        />
        <polyline points={points} className="line" style={{ stroke: color }} />
        {values.map((value, index) => {
          const x = padding + stepX * index
          const y = padding + chartHeight - ((value - min_val) / range) * chartHeight
          const isHovered = hoveredIndex === index

          return (
            <g key={`point-${index}`}>
              <circle
                cx={x}
                cy={y}
                r={isHovered ? 6 : 4}
                className="data-point"
                style={{ fill: color, opacity: isHovered ? 1 : 0.6 }}
                onMouseEnter={() => setHoveredIndex(index)}
                onMouseLeave={() => setHoveredIndex(null)}
              />
              {isHovered && (
                <g>
                  <rect
                    x={x - 72}
                    y={y - 56}
                    width={144}
                    height={44}
                    rx={8}
                    className="tooltip-bg"
                  />
                  <text
                    x={x}
                    y={y - 28}
                    className="tooltip-text"
                    textAnchor="middle"
                  >
                    {formatNumber(value)} {unit}
                  </text>
                </g>
              )}
            </g>
          )
        })}
      </svg>
    </article>
  )
}

// Componente principal com estados, fluxo do teste e renderizacao da interface.
function App() {
  const persistedSchedule = readScheduleFromStorage()
  const persistedScheduleIsValid =
    persistedSchedule?.enabled === true &&
    persistedSchedule.endAt > new Date().getTime()
  const initialSchedule = persistedScheduleIsValid ? persistedSchedule : null

  const [status, setStatus] = useState('Pronto para testar sua velocidade')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SpeedResult | null>(null)
  const [planInput, setPlanInput] = useState('1gb')
  const [progress, setProgress] = useState(0)
  const [activeStep, setActiveStep] = useState<number>(0)
  const [history, setHistory] = useState<HistoryEntry[]>(() => readHistoryFromStorage())
  const [currentSpeed, setCurrentSpeed] = useState<number | null>(null)
  const [cfMeta, setCfMeta] = useState<CloudflareMeta>({ ip: null, colo: null })
  const [scheduleDurationHours, setScheduleDurationHours] = useState('12')
  const [scheduleIntervalHours, setScheduleIntervalHours] = useState('1')
  const [scheduleEnabled, setScheduleEnabled] = useState(Boolean(initialSchedule))
  const [scheduleStartAt, setScheduleStartAt] = useState<number | null>(
    initialSchedule?.startAt ?? null,
  )
  const [scheduleEndAt, setScheduleEndAt] = useState<number | null>(
    initialSchedule?.endAt ?? null,
  )
  const [scheduleNextRunAt, setScheduleNextRunAt] = useState<number | null>(
    initialSchedule?.nextRunAt ?? null,
  )
  const [scheduledRuns, setScheduledRuns] = useState(initialSchedule?.scheduledRuns ?? 0)

  const runningRef = useRef(false)
  const scheduleTimerRef = useRef<number | null>(null)
  const runTestRef = useRef<
    ((source?: 'manual' | 'scheduled') => Promise<boolean>) | null
  >(null)
  const armScheduledRunRef = useRef<((runAt: number) => void) | null>(null)
  const scheduleConfigRef = useRef<{ endAt: number; intervalMs: number } | null>(
    initialSchedule
      ? {
          endAt: initialSchedule.endAt,
          intervalMs: initialSchedule.intervalMs,
        }
      : null,
  )
  const restoredScheduleArmedRef = useRef(false)

  useEffect(() => {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history))
  }, [history])

  useEffect(() => {
    runningRef.current = running
  }, [running])

  useEffect(() => {
    return () => {
      if (scheduleTimerRef.current !== null) {
        window.clearTimeout(scheduleTimerRef.current)
      }
    }
  }, [])

  const planMbps = useMemo(() => parsePlanToMbps(planInput), [planInput])
  const adequacy = useMemo(() => {
    if (!result || !planMbps) {
      return null
    }

    return (result.totalMbps / planMbps) * 100
  }, [planMbps, result])

  const verdict = useMemo(() => {
    if (adequacy === null) {
      return 'Informe seu plano para comparar.'
    }

    if (adequacy >= 90) {
      return 'Sim. Você está recebendo perto do valor contratado.'
    }

    if (adequacy >= 70) {
      return 'Parcialmente. Está abaixo do ideal, mas próximo.'
    }

    return 'Não. Sua internet está bem abaixo do plano informado.'
  }, [adequacy])

  const maxGaugeMbps = SPEEDOMETER_MAX_MBPS

  const getHistoryRowsForExport = () => {
    return history.map((entry) => ({
      'Data e hora': formatDateTime(entry.testedAt),
      'Ping (ms)': formatNumber(entry.pingMs),
      'Download (Mbps)': formatNumber(entry.downloadMbps),
      'Upload (Mbps)': formatNumber(entry.uploadMbps),
      'Total (Mbps)': formatNumber(entry.totalMbps),
      Estabilidade: entry.stabilityLabel,
      'Variação (%)': formatNumber(entry.stabilityVariation),
      'Plano informado': entry.planInput,
      'Plano (Mbps)':
        entry.planMbps !== null ? formatNumber(entry.planMbps) : '-',
      'Cobertura (%)':
        entry.adequacyPercent !== null ? formatNumber(entry.adequacyPercent) : '-',
    }))
  }

  const buildExportFileName = (extension: 'xlsx' | 'pdf') => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    return `historico-speedtest-${stamp}.${extension}`
  }

  const exportHistoryToExcel = () => {
    if (!history.length) {
      return
    }

    try {
      const rows = getHistoryRowsForExport()
      const worksheet = XLSX.utils.json_to_sheet(rows)
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Historico')
      XLSX.writeFile(workbook, buildExportFileName('xlsx'))
    } catch {
      setError('Não foi possível exportar o histórico em Excel.')
    }
  }

  const exportHistoryToPdf = () => {
    if (!history.length) {
      return
    }

    try {
      const doc = new jsPDF({ orientation: 'landscape' })
      const rows = getHistoryRowsForExport()
      const columns = Object.keys(rows[0])

      doc.setFontSize(12)
      doc.text('Histórico de testes de velocidade', 14, 14)

      autoTable(doc, {
        startY: 20,
        head: [columns],
        body: rows.map((row) => columns.map((column) => row[column as keyof typeof row])),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [47, 125, 246] },
      })

      doc.save(buildExportFileName('pdf'))
    } catch {
      setError('Não foi possível exportar o histórico em PDF.')
    }
  }

  const stopScheduledTests = useCallback((nextStatus?: string) => {
    if (scheduleTimerRef.current !== null) {
      window.clearTimeout(scheduleTimerRef.current)
      scheduleTimerRef.current = null
    }

    scheduleConfigRef.current = null
    setScheduleEnabled(false)
    setScheduleNextRunAt(null)

    if (nextStatus) {
      setStatus(nextStatus)
    }
  }, [])

  const armScheduledRun = useCallback((runAt: number) => {
    const config = scheduleConfigRef.current
    if (!config) {
      return
    }

    if (runAt > config.endAt) {
      stopScheduledTests('Agendamento concluido com sucesso.')
      return
    }

    setScheduleNextRunAt(runAt)

    if (scheduleTimerRef.current !== null) {
      window.clearTimeout(scheduleTimerRef.current)
      scheduleTimerRef.current = null
    }

    const waitMs = Math.max(0, runAt - new Date().getTime())

    scheduleTimerRef.current = window.setTimeout(async () => {
      const currentConfig = scheduleConfigRef.current
      if (!currentConfig) {
        return
      }

      if (runAt > currentConfig.endAt) {
        stopScheduledTests('Janela do agendamento encerrada.')
        return
      }

      const nextRunAt = runAt + currentConfig.intervalMs

      if (runningRef.current) {
        // Se houver teste em andamento, adia para manter execucao sem sobreposicao.
        armScheduledRunRef.current?.(nextRunAt)
        return
      }

      const didRun = await runTestRef.current?.('scheduled')
      if (!didRun) {
        armScheduledRunRef.current?.(nextRunAt)
        return
      }

      armScheduledRunRef.current?.(nextRunAt)
    }, waitMs)
  }, [stopScheduledTests])

  useEffect(() => {
    armScheduledRunRef.current = armScheduledRun
  })

  const queueNextScheduledRun = useCallback((fromTimestamp: number) => {
    const config = scheduleConfigRef.current
    if (!config) {
      return
    }

    const nextRunAt = fromTimestamp + config.intervalMs
    armScheduledRun(nextRunAt)
  }, [armScheduledRun])

  // Executa o teste completo em etapas: preparo, ping, download, upload e analise.
  const runTest = async (source: 'manual' | 'scheduled' = 'manual') => {
    if (runningRef.current) {
      return false
    }

    setRunning(true)
    setError(null)
    setResult(null)
    setProgress(0)
    setActiveStep(0)
    setCurrentSpeed(null)

    try {
      const pingSamples: number[] = []

      setStatus('Preparando ambiente de teste...')
      setProgress(2)
      const traceResponse = await fetch(`${CF_BASE}/cdn-cgi/trace?ts=${Date.now()}`, {
        cache: 'no-store',
      })

      if (traceResponse.ok) {
        const traceText = await traceResponse.text()
        setCfMeta(parseTraceResponse(traceText))
      }

      await delay(2_500)

      setActiveStep(1)
      setStatus('Aquecendo conexoes para reduzir variacao inicial...')
      await measureTimedThroughput({
        mode: 'download',
        durationMs: 6_000,
        workers: 2,
        chunkBytes: 2_000_000,
        onProgress: (ratio) => setProgress(2 + ratio * 8),
        onSpeedUpdate: setCurrentSpeed,
      })

      setActiveStep(2)
      const pingAttempts = 20
      for (let i = 0; i < pingAttempts; i += 1) {
        setStatus(`Medindo ping... amostra ${i + 1} de ${pingAttempts}`)
        const start = performance.now()
        const response = await fetch(
          `${CF_BASE}/cdn-cgi/trace?ts=${Date.now()}-${i}`,
          {
            cache: 'no-store',
          },
        )

        if (!response.ok) {
          throw new Error('Falha ao medir o ping.')
        }

        await response.arrayBuffer()
        pingSamples.push(performance.now() - start)
        setProgress(10 + ((i + 1) / pingAttempts) * 20)
        await delay(250)
      }

      setActiveStep(3)
      setStatus('Medindo download profundo em paralelo...')
      const downloadResult = await measureTimedThroughput({
        mode: 'download',
        durationMs: 22_000,
        workers: 6,
        chunkBytes: 6_000_000,
        onProgress: (ratio) => setProgress(30 + ratio * 30),
        onSpeedUpdate: setCurrentSpeed,
      })

      setActiveStep(4)
      setStatus('Medindo upload profundo em paralelo...')
      const uploadResult = await measureTimedThroughput({
        mode: 'upload',
        durationMs: 22_000,
        workers: 5,
        chunkBytes: 2_000_000,
        onProgress: (ratio) => setProgress(60 + ratio * 28),
        onSpeedUpdate: setCurrentSpeed,
      })

      setActiveStep(5)
      setStatus('Conferindo estabilidade do sinal...')
      setProgress(90)
      await delay(5_000)

      const pingMs = trimmedAverage(pingSamples, 0.2)
      const downloadMbps = downloadResult.mbps
      const uploadMbps = uploadResult.mbps
      const totalMbps = downloadMbps + uploadMbps
      const stability = getStability([
        ...downloadResult.samples,
        ...uploadResult.samples,
      ])

      setActiveStep(6)
      setStatus('Executando validacao final das amostras...')
      setProgress(96)
      await delay(4_000)

      setActiveStep(7)
      setProgress(100)

      const currentResult: SpeedResult = {
        pingMs,
        downloadMbps,
        uploadMbps,
        totalMbps,
        pingSamples,
        downloadSamples: downloadResult.samples,
        uploadSamples: uploadResult.samples,
        stabilityLabel: stability.label,
        stabilityVariation: stability.variation,
      }

      setResult(currentResult)

      const planAtTestMbps = parsePlanToMbps(planInput)
      const adequacyAtTest =
        planAtTestMbps && planAtTestMbps > 0
          ? (currentResult.totalMbps / planAtTestMbps) * 100
          : null

      setHistory((previous) => [
        {
          id: crypto.randomUUID(),
          testedAt: new Date().toISOString(),
          pingMs: currentResult.pingMs,
          downloadMbps: currentResult.downloadMbps,
          uploadMbps: currentResult.uploadMbps,
          totalMbps: currentResult.totalMbps,
          stabilityLabel: currentResult.stabilityLabel,
          stabilityVariation: currentResult.stabilityVariation,
          planInput,
          planMbps: planAtTestMbps,
          adequacyPercent: adequacyAtTest,
        },
        ...previous,
      ])

      setStatus('Teste concluído com sucesso')
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Erro desconhecido'
      setError(
        `Não foi possível concluir o teste. Motivo: ${reason}. Verifique conexão, VPN ou bloqueios de rede e tente novamente.`,
      )
      setStatus('Falha no teste')
    } finally {
      setRunning(false)
      if (source === 'scheduled') {
        setScheduledRuns((previous) => previous + 1)
      }
    }

    return true
  }

  useEffect(() => {
    runTestRef.current = runTest
  })

  const startScheduledTests = async () => {
    if (runningRef.current) {
      setError('Aguarde o teste atual terminar para iniciar o agendamento.')
      return
    }

    const durationHours = Number(scheduleDurationHours.replace(',', '.'))
    const intervalHours = Number(scheduleIntervalHours.replace(',', '.'))

    if (!Number.isFinite(durationHours) || durationHours <= 0) {
      setError('Informe uma duracao total valida em horas.')
      return
    }

    if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
      setError('Informe um intervalo valido em horas.')
      return
    }

    const startAt = Date.now()
    const endAt = startAt + durationHours * 3_600_000
    const intervalMs = intervalHours * 3_600_000

    setError(null)
    setScheduleEnabled(true)
    setScheduleStartAt(startAt)
    setScheduleEndAt(endAt)
    setScheduleNextRunAt(null)
    setScheduledRuns(0)
    scheduleConfigRef.current = { endAt, intervalMs }
    setStatus('Agendamento automatico iniciado.')

    const didRun = await runTest('scheduled')
    if (!didRun) {
      stopScheduledTests('Nao foi possivel iniciar o teste automatico.')
      return
    }

    queueNextScheduledRun(startAt)
  }

  useEffect(() => {
    const config = scheduleConfigRef.current

    if (!scheduleEnabled || !config || !scheduleStartAt || !scheduleEndAt) {
      localStorage.removeItem(SCHEDULE_STORAGE_KEY)
      return
    }

    const payload: PersistedSchedule = {
      enabled: scheduleEnabled,
      startAt: scheduleStartAt,
      endAt: scheduleEndAt,
      nextRunAt: scheduleNextRunAt,
      scheduledRuns,
      intervalMs: config.intervalMs,
    }

    localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(payload))
  }, [
    scheduleEnabled,
    scheduleStartAt,
    scheduleEndAt,
    scheduleNextRunAt,
    scheduledRuns,
  ])

  useEffect(() => {
    if (restoredScheduleArmedRef.current) {
      return
    }

    restoredScheduleArmedRef.current = true

    const config = scheduleConfigRef.current
    if (!scheduleEnabled || !config || !scheduleEndAt) {
      return
    }

    const now = new Date().getTime()
    if (now >= scheduleEndAt) {
      localStorage.removeItem(SCHEDULE_STORAGE_KEY)
      return
    }

    const recoveredRunAt =
      scheduleNextRunAt && scheduleNextRunAt > now ? scheduleNextRunAt : now

    armScheduledRun(recoveredRunAt)
  }, [
    armScheduledRun,
    scheduleEnabled,
    scheduleEndAt,
    scheduleNextRunAt,
    stopScheduledTests,
  ])

  return (
    <main className="app-shell">
      <header className="hero">
        <p className="pill">VelocityX</p>
        <h1>Descubra se voce recebe o que paga</h1>
        <p className="subtitle">
          Medimos ping medio (ms), upload e download. Depois somamos upload +
          download para comparar com o seu plano.
        </p>
      </header>

      <section className="board" aria-live="polite">
        <div className="board-head">
          <span className={`dot ${running ? 'running' : 'idle'}`}></span>
          <strong>{status}</strong>
          {(cfMeta.ip || cfMeta.colo) && (
            <small>
              Cloudflare {cfMeta.colo ? `(${cfMeta.colo})` : ''} {cfMeta.ip ? `- ${cfMeta.ip}` : ''}
            </small>
          )}
        </div>

        <button className="primary" onClick={() => void runTest('manual')} disabled={running}>
          <span className="primary-label">
            <img
              src="/sync.svg"
              className="primary-icon"
              alt=""
              aria-hidden="true"
            />
            {running ? 'Executando teste...' : 'Iniciar teste de velocidade'}
          </span>
        </button>

        <div className="progress-wrap" role="status" aria-live="polite">
          <div className="progress-labels">
            <span>Progresso do teste</span>
            <strong>{Math.round(progress)}%</strong>
          </div>
          <Speedometer
            progress={progress}
            activeStep={activeStep}
            totalSteps={TEST_STEPS.length}
            speedMbps={currentSpeed}
            maxGaugeMbps={maxGaugeMbps}
          />
          <div className="step-list">
            {TEST_STEPS.map((step, index) => (
              <span
                key={step}
                className={index <= activeStep ? 'step active' : 'step'}
              >
                {step}
              </span>
            ))}
          </div>
        </div>

        {error ? <p className="error">{error}</p> : null}

        <div className="metrics">
          <article>
            <h2>
              <MetricIcon kind="ping" />
              Ping medio
            </h2>
            <p>{result ? `${formatNumber(result.pingMs)} ms` : '--'}</p>
          </article>
          <article>
            <h2>
              <MetricIcon kind="download" />
              Download
            </h2>
            <p>{result ? `${formatNumber(result.downloadMbps)} Mbps` : '--'}</p>
          </article>
          <article>
            <h2>
              <MetricIcon kind="upload" />
              Upload
            </h2>
            <p>{result ? `${formatNumber(result.uploadMbps)} Mbps` : '--'}</p>
          </article>
          <article>
            <h2>Total (Up + Down)</h2>
            <p>{result ? `${formatNumber(result.totalMbps)} Mbps` : '--'}</p>
          </article>
          <article>
            <h2>Estabilidade</h2>
            <p>{result ? result.stabilityLabel : '--'}</p>
          </article>
        </div>

        {result ? (
          <div className="samples">
            <p className="variation-line">
              Variacao do sinal: {formatNumber(result.stabilityVariation)}%
            </p>
            <div className="charts-grid">
              <LineChart
                title="Download"
                unit="Mbps"
                color="#0b6dff"
                icon="download"
                values={result.downloadSamples}
              />
              <LineChart
                title="Upload"
                unit="Mbps"
                color="#0ea5a4"
                icon="upload"
                values={result.uploadSamples}
              />
              <LineChart
                title="Ping"
                unit="ms"
                color="#f97316"
                icon="ping"
                values={result.pingSamples}
              />
            </div>
          </div>
        ) : null}

        <div className="question-box">
          <label htmlFor="plan">Voce esta recebendo a internet que pagou?</label>
          <div className="input-line">
            <input
              id="plan"
              type="text"
              placeholder="Ex.: 1gb ou 500mb"
              value={planInput}
              onChange={(event) => setPlanInput(event.target.value)}
            />
            <span className="hint">
              Plano: {planMbps ? `${formatNumber(planMbps)} Mbps` : 'invalido'}
            </span>
          </div>
          <p className="verdict">{verdict}</p>
          {result && planMbps && adequacy !== null ? (
            <p className="ratio">
              Voce recebe aproximadamente {formatNumber(adequacy)}% do plano
              informado.
            </p>
          ) : null}
        </div>

        <section className="schedule-box" aria-live="polite">
          <h2>Agendamento automatico de testes</h2>
          <p className="schedule-help">
            Defina a duracao total do monitoramento, em horas, e o intervalo,
            tambem em horas, para a execucao de novos testes. Exemplo para
            amanha: duracao de 12h e intervalo de 1h. E necessario manter esta
            aba aberta durante todo o periodo configurado.
          </p>

          <div className="schedule-grid">
            <label htmlFor="schedule-duration">Duracao total (horas)</label>
            <input
              id="schedule-duration"
              type="number"
              min="0.5"
              step="0.5"
              value={scheduleDurationHours}
              onChange={(event) => setScheduleDurationHours(event.target.value)}
              disabled={scheduleEnabled}
            />

            <label htmlFor="schedule-interval">Executar a cada (horas)</label>
            <input
              id="schedule-interval"
              type="number"
              min="0.5"
              step="0.5"
              value={scheduleIntervalHours}
              onChange={(event) => setScheduleIntervalHours(event.target.value)}
              disabled={scheduleEnabled}
            />
          </div>

          <div className="schedule-actions">
            <button
              className="history-export"
              onClick={() => void startScheduledTests()}
              disabled={scheduleEnabled || running}
            >
              Iniciar agendamento
            </button>
            <button
              className="history-clear"
              onClick={() => stopScheduledTests('Agendamento interrompido pelo usuario.')}
              disabled={!scheduleEnabled}
            >
              Parar agendamento
            </button>
          </div>

          <p className="schedule-status">
            {scheduleEnabled
              ? `Agendamento ativo • Iniciado em ${
                  scheduleStartAt ? formatTimestamp(scheduleStartAt) : '-'
                } • Termina em ${
                  scheduleEndAt ? formatTimestamp(scheduleEndAt) : '-'
                } • Proximo teste em ${
                  scheduleNextRunAt ? formatTimestamp(scheduleNextRunAt) : 'calculando...'
                } • Testes executados: ${scheduledRuns}`
              : 'Agendamento inativo.'}
          </p>
        </section>

        <section className="history-box" aria-live="polite">
          <div className="history-head">
            <h2>Historico de testes</h2>
            <div className="history-actions">
              <button
                className="history-export"
                onClick={exportHistoryToExcel}
                disabled={!history.length}
              >
                Baixar Excel
              </button>
              <button
                className="history-export"
                onClick={exportHistoryToPdf}
                disabled={!history.length}
              >
                Baixar PDF
              </button>
              <button
                className="history-clear"
                onClick={() => setHistory([])}
                disabled={!history.length}
              >
                Limpar historico
              </button>
            </div>
          </div>

          {!history.length ? (
            <p className="history-empty">Nenhum teste registrado ainda.</p>
          ) : (
            <div className="history-list">
              {history.map((entry) => (
                <article className="history-item" key={entry.id}>
                  <p className="history-date">{formatDateTime(entry.testedAt)}</p>
                  <div className="history-grid">
                    <span>Ping: {formatNumber(entry.pingMs)} ms</span>
                    <span>Download: {formatNumber(entry.downloadMbps)} Mbps</span>
                    <span>Upload: {formatNumber(entry.uploadMbps)} Mbps</span>
                    <span>Total: {formatNumber(entry.totalMbps)} Mbps</span>
                    <span>Estabilidade: {entry.stabilityLabel}</span>
                    <span>Variacao: {formatNumber(entry.stabilityVariation)}%</span>
                    <span>
                      Cobertura: {entry.adequacyPercent !== null ? `${formatNumber(entry.adequacyPercent)}%` : '-'}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </section>
    </main>
  )
}

export default App
