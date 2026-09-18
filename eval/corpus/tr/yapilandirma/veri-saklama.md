# Veri saklama ve temizlik

Halyard hiçbir şeyi kendiliğinden sonsuza kadar saklamaz. Saklama süreleri iki ayrı değişkenle
yönetilir ve bu ikisinin ayrı tutulmuş olması, yeniden gönderim yeteneğiniz açısından doğrudan
sonuç doğurur.

## İki ayrı süre

| Değişken | Varsayılan | Neyi siler |
|---|---|---|
| `HALYARD_RETENTION_DELIVERIES` | `30d` | Gönderim satırlarını ve deneme geçmişlerini |
| `HALYARD_RETENTION_PAYLOADS` | `7d` | Olay gövdelerini — hem satır içi olanları hem havuzdaki dosyaları |
| `HALYARD_RETENTION_SWEEP_INTERVAL` | `15m` | (Süre değil) temizleyicinin çalışma sıklığı |

Gövdelerin daha kısa saklanması bilinçli bir varsayılandır. Yedi günün ardından bir gönderimin ne zaman
denendiğini, hangi yanıtı aldığını ve neden başarısız olduğunu hâlâ görebilirsiniz; ama artık yeniden
gönderemezsiniz, çünkü gönderilecek gövde silinmiştir. Bu durumdaki bir yeniden gönderim denemesi
`HLY-1001` ile reddedilir.

Yedi günden daha geriye yeniden gönderim yapmanız düzenli olarak gerekiyorsa değiştirmeniz gereken
değişken `HALYARD_RETENTION_PAYLOADS`'tır. Bunu yapmadan önce depolama maliyetini hesaplayın: gövdeler
hem veritabanının hem yedeklerin boyutunu doğrudan belirler ve bir aylık gövde saklama, tipik bir
kurulumda veritabanını bir aylık gönderim üst verisinin birkaç katına çıkarır.

## Temizleyicinin çalışma biçimi

Temizleyici, sınırlı büyüklükteki toplu işler hâlinde siler ve her toplu iş arasında sırayı diğer
işlemlere bırakır. Böylece uzun süredir temizlenmemiş bir veritabanında ilk çalıştırma, gönderim
işlemlerini kilitleyip durdurmaz; yalnızca daha uzun sürer.

Silme işlemi gönderimden başlayarak yapılır, olaydan değil. Hiçbir gönderimi kalmamış bir olay, kendi
saklama süresi dolduğunda silinir; hâlâ bekleyen bir gönderimi olan olay, gövde saklama süresi dolmuş
olsa bile silinmez.

## Silinmeyen şeyler

- **Uç noktalar.** Silinmeleri açık bir komut gerektirir ve geçmişleriyle birlikte giderler.
- **Anahtarlar.** İptal edilen anahtarlar, denetim izi olarak satırda kalır; yalnızca özetleri
  saklandığı için kalmalarının bir sakıncası yoktur.
- **Zamanlamalar.** Bir zamanlamanın ürettiği olaylar sıradan olaylardır ve saklama sürelerine tabidir;
  zamanlamanın kendisi tabi değildir.

## Yedeklerle ilişkisi

Temizleyici bir yedekleme aracı değildir ve yedeklemenin yerine geçmez. Ama ikisi birbirini etkiler:
`--exclude-payloads` ile alınmış bir yedek, gövdeleri zaten içermediğinden, geri yüklendiğinde
yeniden gönderilebilecek olayların kümesi veritabanında satır içi kalmış küçük gövdelerle sınırlıdır.
Yeniden gönderilebilirliğin sizin için önemli olduğu bir kurulumda tam yedek almanız gerekir.

## Yer açmak için ne yapılmaz

Gönderim ya da deneme tablolarından doğrudan `DELETE` çalıştırmayın. Yük havuzundaki dosyalar
veritabanındaki satırlardan referans alınır ve temizleyici hangi dosyanın silinebileceğine bu
referanslara bakarak karar verir. Satırları elle sildiğinizde havuzdaki dosyalar hiçbir zaman
toplanmayan artıklara dönüşür ve diski, kimsenin bakmayı düşünmeyeceği bir yerde doldururlar.

Gerçekten acil yer açmanız gerekiyorsa, `HALYARD_RETENTION_PAYLOADS` değerini düşürüp temizleyicinin bir
turunu beklemek doğru yoldur ve dakikalar sürer.
