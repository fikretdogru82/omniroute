# OmniRoute — Render.com Uyku Modu Engelleme Rehberi

Render.com **free tier**, 15 dakika gelen istek olmazsa instance'ı uyutur ("sleep mode").
Uyandırma ilk istekte 30–60 saniye sürer ve ilk istek hata/gecikme yaşar.

Bu rehber, OmniRoute'un **hiç uykuya girmemesini** sağlayan 4 katmanlı bir strateji sunar.

---

## Katmanlı Strateji

| Katman | Ne yapar | Nerede |
|--------|----------|--------|
| **L1 — Self-ping (Supervisor)** | OmniRoute'u başlatır ve her 5 dk'da bir `/api/health/ping`'e istek atar. Instance hiç "inactive" kalmaz. | [`scripts/dev/keep-alive.mjs`](../scripts/dev/keep-alive.mjs) + [`render.yaml`](../render.yaml) |
| **L2 — Render Health Check** | Render, her ~1 dk'da bir `/api/health/ping`'i kendi izler. 503 → otomatik restart. | [`render.yaml`](../render.yaml) |
| **L3 — Cron Job** | Web service uyusa bile harici job her 5 dk'da bir ping atarak uyandırır. | [`render.yaml`](../render.yaml) |
| **L4 — UptimeRobot** | Render dışı 3. parti izleme: hem uykuda olanı uyandırır hem çökme anında e-posta/SMS uyarır. | Aşağıdaki bölüm |

> L1+L2 bir kez kurulunca instance pratikte hiç uyumaz. L3+L4 ise "her ihtimale karşı" yedek katmanlardır.

---

## Oluşturulan / Değiştirilen Dosyalar

| Dosya | İşlem |
|-------|-------|
| [`scripts/dev/keep-alive.mjs`](../scripts/dev/keep-alive.mjs) | **Yeni** — Supervisor + ping scripti (`--supervise`, `--once`, loop modları) |
| [`render.yaml`](../render.yaml) | **Yeni** — Render Blueprint: web service + health check + cron job |
| [`Dockerfile`](../Dockerfile) | **Değişti** — `keep-alive.mjs` runner image'a kopyalandı (healthcheck.mjs yanına) |
| [`package.json`](../package.json) | **Değişti** — `npm run keep-alive` ve `npm run keep-alive:once` scriptleri eklendi |
| [`docs/RENDER_KEEP_ALIVE.md`](RENDER_KEEP_ALIVE.md) | **Yeni** — Bu rehber |

---

## 1) Lokal Test (2 dakika)

OmniRoute **zaten lokalde 20128 portunda** çalışıyorsa:

```bash
# Tek seferlik ping (server ayakta mı?)
node scripts/dev/keep-alive.mjs --once --url=http://127.0.0.1:20128

# Sürekli ping döngüsü (her 5 dk'da bir; Ctrl+C ile durdur)
npm run keep-alive
```

Beklenen çıktı:

```
[keep-alive] PING 200 OK (2ms) → http://127.0.0.1:20128/api/health/ping
```

`200` dönüyorsa her şey yolunda. `503` dönerse server ayakta ama DB'de sorun var.
Ağ hatası (network error) dönerse server kapalı demektir.

---

## 2) Render.com'a Deploy (Blueprint)

### Ön koşullar

- OmniRoute klasörünü **kendi GitHub reponuza** push edin:
  ```bash
  cd OmniRoute-release-v3.8.50
  git init && git add -A && git commit -m "OmniRoute + keep-alive"
  git remote add origin https://github.com/KULLANICI-ADI/omniroute.git
  git push -u origin main
  ```

- [`render.yaml`](../render.yaml) içindeki 2 yer tutucuyu düzeltin:
  1. `repo: https://github.com/KULLANICI-ADI/omniroute`
  2. `KEEP_ALIVE_URL: https://omniroute.onrender.com` (deploy öncesi URL'yi bilmiyorsanız önce deploy edip sonra güncelleyip redeploy edin)

### Adımlar

1. [render.com](https://render.com) → **New** → **Blueprint**
2. Reponuzu seçin → Render, `render.yaml`'ı otomatik okur
3. `Apply Blueprint` → web service + cron job oluşur
4. Build ~15–20 dk sürer (Docker build: native modüller derlenir)
5. Deploy tamamlanınca `https://omniroute.onrender.com` adresinden dashboard'a girin

### Deploy sonrası kontrol

```bash
# Health endpoint (auth'suz, herkese açık)
curl https://omniroute.onrender.com/api/health/ping
# → {"status":"ok","timestamp":"...","latencyMs":...}
```

Dashboard'a giriş için API key kullanın (kurulumda oluşturduğunuz `sk-...` anahtarı).

---

## 3) UptimeRobot Kurulumu (L4 — ücretsiz)

[UptimeRobot](https://uptimerobot.com) ücretsiz planda **50 monitor** ve **5 dk'lık**
kontrol aralığı sunar. Render'ın saat limitini **hiç etkilemez** (dışarıdan çalışır).

### Adımlar

1. [uptimerobot.com](https://uptimerobot.com) → ücretsiz hesap açın
2. **+ Add New Monitor**
3. Monitor Type: **HTTPS**
4. Friendly Name: `OmniRoute Keep-Alive`
5. URL:
   ```
   https://omniroute.onrender.com/api/health/ping
   ```
6. Monitoring Interval: **5 minutes** (ücretsiz planda minimum)
7. Timeout: `30` saniye
8. Alert Contacts: kendi e-postanızı ekleyin
9. **Create Monitor**

UptimeRobot her 5 dk'da bir istek atar → instance hiç uyumaz + çökerse anında
e-posta uyarısı alırsınız. (UptimeRobot, OmniRoute 200 döndüğü sürece "UP" sayar;
`503` dönerse "DOWN" sayar ve uyarır.)

> **Alternatifler:** [cron-job.org](https://cron-job.org), [Kaffeine](https://kaffeine.herokuapp.com)
> (Heroku'ya özel), [BetterStack Uptime](https://betterstack.com/uptime) (ücretsiz katmanı var).

---

## Önemli Uyarılar

### ⚠️ Free plan saat limiti (750 saat/ay)

- Render free tier, **tüm servisler arasında 750 instance-saat/ay** paylaştırır.
- Tek web service sürekli çalışırsa: ~31 gün → limitin tamamını kullanır.
- **Cron job eklenirse** o da saat tüketir (~5 dk'da bir ~30 sn → ayda ~72 saat ek).
  Toplam limiti aşma riskine karşı cron job'ı [`render.yaml`](../render.yaml)'dan
  silip yalnızca L1+L2+L4'e güvenebilirsiniz.
- UptimeRobot **hiç** saat tüketmez.

### ⚠️ SQLite verisi ve persistent disk

- Free plan'da **persistent disk yoktur**. `/app/data` (SQLite verileri: API key'ler,
  provider bağlantıları, ayarlar) her instance restart/deploy'da **silinir**.
- Verilerin kalıcı olması için:
  - **Paid plan** (Starter ~$7/ay): [`render.yaml`](../render.yaml) içindeki `disk:`
    bloğunu açın, 1 GB disk ekleyin → veriler kalıcı olur.
  - **Ücretsiz alternatif:** OmniRoute'u lokalde çalıştırıp verileri **kalıcı VPS**
    (Hetzner/Railway/Heroku) üzerinde tutmak daha sağlıklı olabilir.

### ⚠️ OmniRoute dashboard şifresi

`render.yaml` içinde `OMNIROUTE_ADMIN_PASSWORD` bloğunu açarak dashboard'a
şifreli erişim ekleyin (herkese açık internette önerilir).

---

## Sık Sorunlar

| Sorun | Çözüm |
|-------|-------|
| İlk istek 30–60 sn yavaş | Instance uyumuş olabilir — L1/L4 ping'leri kurulunca bir daha yaşanmaz |
| `dockerCommand` çalışmıyor | Render'da service ayarlarından `Command` alanının `node keep-alive.mjs --supervise` olduğunu doğrulayın |
| Build sırasında `better-sqlite3` hatası | Dockerfile'da `node-gyp rebuild` zaten var; build log'unda doğrulayın |
| Health check 503 | Server ayakta ama DB'de sorun → render logs (`/api/health/ping` hatası) inceleyin |
| Cron job free plan'da yok | [`render.yaml`](../render.yaml)'dan cron bloğunu silin, UptimeRobot yeterli |
| Dashboard'a giremiyorum | Lokalde oluşturduğunuz API key'i Render'daki instance'a **taşıyamazsınız** (SQLite silindi). Render dashboard'unda yeni API key oluşturun |

---

## Özet Komutlar

```bash
# Lokal tek ping
npm run keep-alive:once

# Lokal sürekli ping döngüsü
npm run keep-alive

# Render'da kullanılan supervisor modu (OmniRoute'u da başlatır)
node keep-alive.mjs --supervise

# Render cron job modu (tek ping)
node keep-alive.mjs --once
```
