# MotoGPX oyun sunucusu

Oda kodlu (2–8 kişi) canlı konum aktarıcı. Bağımlılık yok, sadece **Node 18+**. Hesap, veritabanı, `npm install` gerekmez.

## Yerelde dene
```
node server.js
```
Tarayıcıda `http://localhost:8080/health` → `{"ok":true,...}` görmelisin. Oyunda adres olarak `localhost:8080` yaz.

## İnternete koy (ücretsiz seçenekler)
**Render.com** (en kolayı)
1. Bu klasörü bir GitHub deposuna yükle.
2. Render → New → Web Service → depoyu seç.
3. Runtime: **Node** · Build Command: boş bırak · Start Command: `node server.js` · Plan: Free.
4. Yayına alınca `https://adin.onrender.com` gibi bir adres verir.

Ücretsiz planda sunucu ~15 dk kimse bağlanmazsa uyur; ilk bağlanan 30–60 sn bekler. Sürekli açık istersen ücretli plan ya da küçük bir VPS kullan.

**Fly.io / Railway / VPS:** `Dockerfile` hazır (`fly launch` ya da `docker build`). VPS'te `PORT=8080 node server.js` + HTTPS için Caddy/nginx arkasında çalıştır. Oyun HTTPS sayfasından bağlandığı için sunucu adresi **wss (HTTPS)** olmalı; Render/Fly bunu otomatik verir.

## Oyuna bağla
Siteye yönetici olarak gir → **Yönetici → Ekonomi ve site → Oyun sunucusu (online)** →
adresi yaz (örn. `adin.onrender.com`) → **Bağlantıyı dene** → ✔ görünce **Kaydet**.
Artık herkes Sunucular ekranında oda koduyla (örn. `PK7P2`) arkadaşlarıyla buluşur.

## Ayarlar (ortam değişkenleri, hepsi isteğe bağlı)
| Değişken | Varsayılan | Anlamı |
|---|---|---|
| `PORT` | 8080 | Dinlenecek port (Render kendisi verir) |
| `ALLOWED_ORIGINS` | `*` | Virgülle ayrılmış izinli site adresleri (örn. `https://siten.com`) |
| `MAX_PER_IP` | 12 | Bir IP'den en fazla eşzamanlı bağlantı |
| `MAX_ROOMS` | 500 | Aynı anda en fazla oda |
| `PUBLIC_DIR` | `./public` | Varsa buradaki dosyalar da sunulur (siteyi aynı yerden yayınlamak için) |

## Güvenlik notları
Sunucu sadece konum/ad/renk/kısa sohbet aktarır; her alan sunucuda doğrulanır ve sınırlanır (boyut, hız, sayı). Hesap/şifre/para bilgisi sunucuya hiç gitmez. Oda kodunu bilen herkes odaya girer; kod tahmini zor olsun diye 5 karakter (harf/rakam) kullanılır.
