# Techin Browser — Kurulum ve Kullanım

Chromium tabanlı, Arc tarzı kenar çubuklu, gizlilik odaklı tarayıcı.
Motor: castlabs Electron 44 (Chromium 152 + Widevine DRM).

## Kurulum

`dist\Techin-Browser-Setup-1.0.2.exe` dosyasını çalıştırın.
Dosya dijital olarak imzalı olmadığı için Windows ilk seferde
"Windows bilgisayarınızı korudu" diyebilir: **Ek bilgi → Yine de çalıştır**.

Varsayılan tarayıcı yapmak için: Ayarlar → Genel → **Varsayılan yap**
(yalnızca kurulu sürümde çalışır; ardından açılan Windows ayarlarında Techin'i seçin).

## Geliştirici komutları

Node: `T:\Tools\node` (PATH'e ekleyin).

| Komut | Ne yapar |
|---|---|
| `npm start` | Tarayıcıyı geliştirme modunda açar |
| `npm test` | Birim testleri (adres çözümleme, güvenlik kuralları, ayar doğrulama…) |
| `npm run selftest` | Gerçek pencere açıp ~70 uçtan uca test çalıştırır (geçici profil kullanır) |
| `npm run selftest:full` | Aynısı + gerçek Widevine korumalı video oynatma testi |
| `npm run dist` | Kurulum dosyasını `dist\` klasörüne üretir |
| `npm run icons` | `build\logo-source.png` dosyasından simgeleri yeniden üretir |

Öz-test raporu ve ekran görüntüleri: `%TEMP%\techin-selftest-out\`.

## Güncellemeler

Kurulu tarayıcı açılışta ve 6 saatte bir GitHub'daki `Tekinsv/techin-browser` sürümlerini denetler.
Yeni sürüm varsa "Yeni güncelleme var, indirmek ister misiniz?" penceresi ve üst çubukta yeşil
**Güncelleme var** düğmesi çıkar. İndirme bitince **Yeniden başlat ve güncelle** (ya da tarayıcı
kapanınca kendiliğinden kurulur). Elle denetim: Ayarlar → Hakkında → Güncellemeleri denetle.

Yeni sürüm yayınlamak için:

```
powershell -ExecutionPolicy Bypass -File yayinla.ps1 -Surum 1.0.2 -Notlar "Neler değişti"
```

## Özellikler

- **Arc tarzı üst çubuk:** ortada adres + bağlantı kopyalama düğmesi + site ayarları, sağ üstte pencere düğmeleri,
  kenar çubuğunu gizleme (Ctrl+Shift+S), bölünmüş görünüm — iki sekme yan yana (Ctrl+Shift+\).
- **Arc tarzı kenar çubuğu:** sık kullanılanlar (üstte kutucuklar), alanlar (Spaces — her birinin kendi rengi/simgesi),
  sabitlenmiş sekmeler, günlük sekmeler, komut çubuğu (Ctrl+T), kompakt kenar çubuğu (Ctrl+Shift+S),
  sürükle-bırak, kenar çubuğunda iki parmakla kaydırarak alan değiştirme.
- **Özelleştirme:** açık/koyu/sistem tema, Mika (Windows 11 saydamlık), alan renkleri, kenar çubuğu
  sol/sağ ve genişliği, köşe yuvarlaklığı, boşluklar, yazı boyutu, 7 arama motoru + özel adres, Türkçe/İngilizce.
- **Akıcılık:** Firefox/Edge tarzı momentumlu kaydırma, GPU ile çizim, Windows 11 kaydırma çubukları.
- **Düşük RAM:** kullanılmayan sekmeler uyutulur (geri/ileri geçmişi korunur), oturum geri yüklenirken
  sekmeler uykuda başlar, reklam engelleyici gereksiz yüklemeyi keser. Ayarlar → Performans'ta canlı bellek listesi.
- **DRM:** Widevine hazır; korumalı video oynatma test edildi.

## Güvenlik

- Her sekme ayrı **sandbox** işleminde; site izolasyonu açık; sayfaların Node.js/iç kanal erişimi yok.
- Arayüz, web sayfalarının erişemediği özel `techin-ui://` protokolünden yüklenir; ağa çıkamaz (sıkı CSP).
- Kamera, mikrofon, konum, bildirim → siteye özel sorulur ve hatırlanır; USB/HID/seri cihaz erişimi kapalı.
- Harici uygulama bağlantıları (mailto:, zoommtg:…) önce sorulur; tehlikeli protokoller (ms-msdt vb.) reddedilir.
- Reklam/izleyici engelleyici (Ghostery motoru, EasyList/EasyPrivacy), zararlı + oltalama site listeleri
  (URLhaus, OpenPhish/PhishTank kaynaklı), yalnızca HTTPS modu, GPC sinyali.
- Sertifika hatalarında tam sayfa uyarı; indirilen dosyalar SmartScreen için işaretlenir, aynı adlı dosyanın üzerine yazılmaz.
- Paketli exe'de Electron sigortaları kapalı (RunAsNode, NODE_OPTIONS, --inspect), app.asar bütünlük denetimi açık,
  çerezler Windows DPAPI ile şifreli.

## Netflix / Disney+ için VMP imzası (isteğe bağlı)

Widevine çalışıyor, fakat Netflix gibi büyük servisler lisansı yalnızca **üretim VMP imzası** olan tarayıcılara verir.
Bu imza ücretsizdir ama castlabs'ta **sizin açacağınız** bir hesap gerekir:

```
pip install --upgrade castlabs-evs
python -m castlabs_evs.account signup
```

Sonra imzalı kurulum üretmek için:

```
set TECHIN_VMP_SIGN=1
npm run dist
```

## Google hesabıyla giriş

Google, Chrome dışındaki Chromium tabanlı tarayıcıları giriş sayfasında engelliyor. Techin yalnızca
accounts.google.com üzerinde kendini Firefox olarak tanıtır (Min Browser'ın yöntemi); diğer tüm sitelerde Chrome'dur.

## Bilinen sınırlar

- Chrome Web Mağazası eklentileri desteklenmiyor.
- Yerleşik şifre yöneticisi ve senkronizasyon yok (Bitwarden gibi bir uygulama önerilir).
- Google Safe Browsing yerine açık kaynak tehdit listeleri kullanılır.
- Chromium güvenlik yamaları için ara sıra castlabs Electron sürümünü yükseltip `yayinla.ps1` ile yeni sürüm çıkarın.

## Klasör yapısı

```
src/main/     ana süreç (pencere, sekme, güvenlik, indirmeler, koruma, IPC, öz-test)
src/preload/  arayüz köprüsü (yalnızca Techin arayüzü için)
src/ui/       arayüz (HTML/CSS/JS, simgeler)
src/shared/   Türkçe/İngilizce metinler
scripts/      simge üretimi, paketleme kancaları (fuses, VMP)
test/         birim testleri
```
