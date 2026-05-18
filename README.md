# SpeedTest Web App

Aplicação web para medição de velocidade de internet com foco em experiência visual, leitura clara de métricas e histórico exportável.

O projeto mede:

- Ping médio (ms)
- Download (Mbps)
- Upload (Mbps)
- Soma de throughput (Upload + Download)
- Variação/estabilidade do sinal

Também permite:

- Comparar o resultado com o plano informado pelo usuário
- Salvar histórico no navegador
- Exportar histórico em Excel (.xlsx)
- Exportar histórico em PDF

---

## 1. O que é este projeto

Este projeto é um SpeedTest feito com React + TypeScript + Vite.

Ele foi pensado para:

1. Entregar um teste de velocidade direto no navegador, sem backend obrigatório.
2. Mostrar progresso detalhado por etapas (aquecimento, ping, download, upload, validação).
3. Exibir resultados em cards e gráficos de linha para facilitar leitura.
4. Ajudar o usuário a responder se está recebendo o que contratou no plano.
5. Permitir auditoria posterior por meio de histórico local e exportações.

---

## 2. Stack técnica

- React 19
- TypeScript
- Vite
- jsPDF + jspdf-autotable (exportação PDF)
- xlsx (exportação Excel)

---

## 3. Requisitos

Antes de rodar, você precisa de:

- Node.js 18+ (recomendado Node 20+)
- npm 9+
- Navegador moderno com suporte a:
  - Fetch API
  - Web Crypto API
  - localStorage

---

## 4. Instalação

Na raiz do projeto, execute:

```bash
npm install
```

Esse comando instala todas as dependências, incluindo bibliotecas de exportação.

---

## 5. Como executar

### 5.1 Desenvolvimento

```bash
npm run dev
```

Depois, abra a URL informada no terminal (geralmente `http://localhost:5173`).

### 5.2 Build de produção

```bash
npm run build
```

Gera saída otimizada na pasta `dist/`.

### 5.3 Preview local da build

```bash
npm run preview
```

Serve o build localmente para validação de comportamento em modo produção.

### 5.4 Lint

```bash
npm run lint
```

Executa regras de qualidade e consistência de código.

---

## 6. Como usar (guia detalhado)

### 6.1 Fluxo básico

1. Abra a aplicação.
2. Clique em **Iniciar teste de velocidade**.
3. Aguarde o teste percorrer todas as etapas.
4. Veja os resultados finais nos cards e gráficos.
5. Opcionalmente informe seu plano (ex.: `1gb`, `500mb`) para comparação.
6. Consulte o veredito e a cobertura aproximada do plano.

### 6.2 Leitura das métricas

- **Ping médio (ms):** latência, quanto menor melhor.
- **Download (Mbps):** taxa de recebimento de dados.
- **Upload (Mbps):** taxa de envio de dados.
- **Total (Up + Down):** soma de throughput para referência do app.
- **Estabilidade:** classificação baseada na variação das amostras.

### 6.3 Interpretação rápida

- Ping baixo + estabilidade alta: experiência mais responsiva.
- Download alto: melhor para streaming/downloads grandes.
- Upload alto: melhor para envio de arquivos, live e videochamadas.
- Variação baixa: comportamento mais previsível da conexão.

---

## 7. Como funciona o teste (detalhamento técnico)

O teste segue estágios progressivos:

1. **Preparação do ambiente**
2. **Aquecimento da conexão** para reduzir ruído inicial
3. **Ping em múltiplas amostras**
4. **Download profundo em paralelo**
5. **Upload profundo em paralelo**
6. **Análise de estabilidade**
7. **Validação final**
8. **Publicação do resultado**

### 7.1 Download/Upload

- São disparados workers paralelos com requisições repetidas por uma janela de tempo.
- O app acumula bytes transferidos e calcula Mbps por tempo decorrido.
- Também coleta amostras periódicas para os gráficos.

### 7.2 Ping

- O app usa a API publica da Cloudflare em `https://speed.cloudflare.com/cdn-cgi/trace` para medir o tempo de ida/volta.
- O valor final usa média aparada (trimmed average), reduzindo impacto de extremos.

### 7.4 Endpoints Cloudflare usados

- `https://speed.cloudflare.com/cdn-cgi/trace` para latencia (ping) e metadados do PoP (colo).
- `https://speed.cloudflare.com/__down` para estimativa de download.
- `https://speed.cloudflare.com/__up` para estimativa de upload.

### 7.3 Estabilidade

- Usa variação percentual sobre as amostras.
- Classificação atual:
  - **Estável**
  - **Moderada**
  - **Instável**

---

## 8. Comparação com plano contratado

O campo de plano aceita formatos como:

- `1gb`
- `500mb`
- `300`

O app converte para Mbps e calcula a cobertura aproximada:

```text
cobertura (%) = (total_mbps / plano_mbps) * 100
```

Com isso, apresenta um veredito textual para facilitar interpretação.

---

## 9. Histórico local

Cada execução concluída salva no `localStorage`:

- Data/hora
- Ping
- Download
- Upload
- Total
- Estabilidade
- Variação
- Plano informado
- Cobertura calculada

O histórico fica no próprio navegador/dispositivo. Não há sincronização em nuvem.

---

## 10. Exportação do histórico

Na seção **Histórico de testes**, você encontra:

- **Baixar Excel**
- **Baixar PDF**
- **Limpar histórico**

### 10.1 Excel (.xlsx)

- Gera planilha com uma linha por teste.
- Inclui todas as métricas principais + plano/cobertura.
- Ideal para análise numérica, filtros e comparações temporais.

### 10.2 PDF

- Gera tabela em modo paisagem.
- Útil para enviar relatório, registrar atendimento técnico ou anexar evidências.

---

## 11. Estrutura de pastas

```text
SpeedTest/
├── public/
│   ├── Download.svg
│   ├── Upload.svg
│   ├── Ping.svg
│   └── sync.svg
├── src/
│   ├── App.tsx        # Fluxo principal, teste, histórico e exportação
│   ├── App.css        # Layout e estilos da interface
│   ├── index.css      # Tokens e tema global
│   └── main.tsx       # Bootstrap da aplicação
├── package.json
└── README.md
```

---

## 12. Limitações importantes

1. Resultados podem variar por:
   - Congestionamento da rede
   - Tipo de conexão (Wi-Fi vs cabo)
   - Distância/rota até endpoint
   - Uso simultâneo de banda por outros apps/dispositivos

2. Testes no navegador não substituem ferramentas profissionais de diagnóstico de camada baixa.

3. VPN, proxy, firewall corporativo ou bloqueios podem impactar medições.

4. Histórico é local; limpar dados do navegador remove os registros.

---

## 13. Troubleshooting (solução de problemas)

### 13.1 O teste falha no meio

- Verifique conectividade.
- Desative VPN temporariamente.
- Teste outra rede.
- Tente novamente após alguns minutos.

### 13.2 Resultado muito abaixo do esperado

- Repita teste em horários diferentes.
- Teste via cabo de rede, não Wi-Fi.
- Feche apps com alto consumo de banda.
- Compare múltiplas medições no histórico.

### 13.3 Exportação não baixa arquivo

- Verifique bloqueio de pop-up/download no navegador.
- Teste em aba normal (fora do modo restrito).
- Tente outro navegador para validar.

### 13.4 Interface sem ícones

- Confirme se os SVGs estão na pasta `public/`.
- Recarregue a página com cache limpo.

---

## 14. Segurança e privacidade

- O app não exige login.
- Histórico é salvo localmente no navegador.
- Não há backend obrigatório para funcionamento principal.
- Ao exportar, os arquivos são gerados no cliente (navegador).

---

## 15. Melhorias futuras sugeridas

- Exportação CSV além de Excel/PDF
- Filtro por período no histórico
- Dashboard comparativo mensal
- Modo técnico com métricas avançadas
- Endpoint próprio para identificação robusta de provedor/ASN

---

## 16. Licença

MIT

