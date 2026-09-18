# Günlük kayıtları

Halyard varsayılan olarak JSON satırları yazar. Biçimi `HALYARD_LOG_FORMAT` belirler ve `text` değeri
yalnızca bir uçbirimde okumak içindir — ayrıştırılmaya elverişli olacak kadar kararlı değildir ve ara
sürümlerde değişebilir.

## Bir satırda ne var

Her satırda `ts`, `level` ve `msg` bulunur. Bağlama göre eklenenler şunlardır:

| Alan | Ne zaman var |
|---|---|
| `request_id` | API isteği bağlamındaki her satırda; yanıtın `X-Request-Id` başlığıyla aynıdır |
| `delivery_id` | Gönderim ve deneme satırlarında |
| `event_id` | Olay yayımlandığında ve gönderim satırlarında |
| `endpoint_id` | Uç noktayla ilgili her satırda |
| `attempt` | Deneme satırlarında, 1'den başlayarak |
| `code` | Başarısızlıklarda; `HLY-NNNN` biçiminde |
| `duration_ms` | Tamamlanmış denemelerde ve API isteklerinde |

`request_id` alanının yanıt başlığıyla aynı olması, bir kullanıcının bildirdiği tek bir isteğin ürettiği
bütün satırların bulunabilmesi içindir. Bir hata bildirimi aldığınızda isteyeceğiniz ilk şey bu
değerdir.

## Seviyeler

`HALYARD_LOG_LEVEL` varsayılan olarak `info`'dur ve üretimde bırakılması gereken değer budur.

- `info` — başlangıç, kapanış, göç, uç nokta değişiklikleri, kalıcı başarısızlıklar.
- `debug` — her deneme için bir satır: sonuç, süre, yanıt kodu. Tek bir uç noktayı incelerken tam olarak
  istediğiniz şeydir; açık bırakıldığında ise kuyruk hacminiz kadar satır üretir.
- `trace` — ayrıca kuyruk sorgularını ve kiralama hareketlerini yazar. Bir hata bildirimi için istendiğinde
  açılır, sonra kapatılır.

Seviye çalışırken değiştirilemez; değişiklik için sürecin yeniden başlatılması gerekir. Bu, kasıtlı
olarak eklenmemiş bir özelliktir: çalışma zamanında seviye değiştiren bir uç, kimlik doğrulaması
gerektiren ve yanlışlıkla açık bırakılabilen bir uçtur.

## Günlüklerde aranmaya değer kalıplar

**`code` alanı `HLY-2007` olan satırlar.** Bir uç nokta adresinin gönderim anında bağlantı-yerel ya da
üst veri servisi adresine çözümlendiği anlamına gelir. Tek bir satır bile DNS'te bir değişiklik olduğunu
ya da birinin denediğini gösterir.

**Her başlangıçta yinelenen kullanımdan kaldırma uyarıları.** `HALYARD_WEBHOOK_SECRET` hâlâ tanımlıysa
her başlangıçta bir uyarı satırı yazılır ve 3.0.0'da bu değişken sunucunun başlamamasına yol açar.

**Aynı `delivery_id` için beklenenden fazla `attempt` satırı.** Kiralaması dolmuş bir gönderimin ikinci
kez üstlenilmiş olabileceğini gösterir; tasarımın kabul ettiği bir durumdur ama sıklaşması, kiralama
süresinin gönderim süresine göre kısa kaldığı anlamına gelir.

## Toplama

Halyard günlükleri standart çıktıya yazar ve kendisi hiçbir yere göndermez. Dosyaya yazma, döndürme ve
uzak toplayıcıya iletme işleri, sizin zaten çalıştırdığınız altyapının işidir — systemd altında
`journald`, Kubernetes altında düğüm üzerindeki toplayıcı.

Bu bilinçli bir sadeleştirmedir. Günlük dosyası döndüren bir uygulama, diski dolduran ve kimsenin
beklemediği bir anda yazamaz duruma gelen bir uygulamadır; `HLY-5011` ile karışan bir arıza sınıfı
üretmesinin hiçbir gereği yoktur.
