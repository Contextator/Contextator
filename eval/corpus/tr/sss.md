# Sık sorulan sorular

## Aynı olay alıcıma iki kez ulaşabilir mi?

Evet. Halyard "en az bir kez" teslim eder ve bu kapatılabilir bir davranış değildir. Alıcınızın
`X-Halyard-Delivery-Id` başlığına bakarak yinelenenleri ayıklaması gerekir; bu başlık aynı gönderimin
bütün denemelerinde aynıdır.

`X-Halyard-Event-Id` bu iş için uygun değildir: tek bir olay birden çok uç noktaya dağıtılır ve elle
yapılan bir yeniden gönderim, aynı olay kimliğiyle yeni bir gönderim kimliği üretir. Olay kimliğine göre
ayıklayan bir alıcıda, kasıtlı yeniden gönderimler sessizce yok sayılır.

## Olaylar yayımlandıkları sırayla mı ulaşır?

Hayır, hiçbir anlamda. Uç nokta bazında, olay türü bazında ya da yük içindeki herhangi bir anahtar
bazında sıra güvencesi yoktur. Sıraya ihtiyacınız varsa yükün içine bir sürüm numarası koyun ve alıcıda
eskimiş olanı atın.

## Bir alıcı yavaşsa diğerleri de etkilenir mi?

Uç nokta başına bir sınır koymadıysanız, evet. Zaman aşımına uğrayan tek bir uç nokta, bütün
kopyalardaki bütün işçileri meşgul edebilir. `halyardctl endpoints update <id> --max-in-flight 4`
komutu bunun önüne geçer ve yeni bir kurulumda her uç nokta için baştan ayarlanması iyi bir alışkanlıktır.

## Yeniden gönderim ne kadar geriye gidebilir?

`HALYARD_RETENTION_PAYLOADS` kadar; varsayılanı yedi gündür. Bundan eski gönderimlerin gövdeleri
silinmiştir ve yeniden gönderim denemesi `HLY-1001` ile reddedilir. Gönderimin kendisi ve deneme
geçmişi `HALYARD_RETENTION_DELIVERIES` boyunca — varsayılan otuz gün — görüntülenebilir kalır.

## Alıcım `410 Gone` döndürürse ne olur?

Uç nokta kendiliğinden devre dışı bırakılır ve bekleyen gönderimleri durur. Bu, bir sonuç değil bir
talimat olarak ele alınan tek durum kodudur. Uç noktayı yeniden etkinleştirmek, alıcı hâlâ aynı yanıtı
veriyorsa onu tekrar devre dışı bıraktırır.

## Bir uç noktaya yönlendirme (redirect) koyabilir miyim?

Hayır. Yönlendirmeler izlenmez; `3xx` yanıtı bir başarısızlıktır. Bu, sunucu tarafı istek sahteciliğine
karşı alınan önlemlerin bir parçasıdır ve yapılandırmayla açılamaz. Adres değiştiyse uç noktanın
adresini güncelleyin.

## Özel başlık gönderebilir miyim?

Evet, uç nokta tanımındaki `headers` alanıyla. Ancak `X-Halyard-*` başlıklarının ve `Content-Type`
başlığının üzerine yazılamaz. Buraya bir taşıyıcı jeton koyarsanız, veritabanına erişen herkesin o
jetona eriştiğini unutmayın.

## Birden çok kopyada zamanlayıcıyı açık bırakabilir miyim?

2.6.0'dan itibaren evet. Her oluşum için zamanlama başına bir kiralama alınır ve oluşumu yalnızca bir
kopya tetikler. Daha eski sürümlerde tek bir kopyada açık tutmayı kurulumun kendisi ayarlamak zorundaydı.

## Neden `HALYARD_QUEUE_POLL_INTERVAL` değerini düşürmemeliyim?

Düşürebilirsiniz, ama 100 ms altında kazanacağınız gecikme fark edilmezken veritabanına düşen sorgu
yükü fark edilir. Kuyruk gecikmesi sorununuz varsa neden neredeyse hiçbir zaman yoklama aralığı
değildir; `halyard_queue_oldest_seconds` ile `halyard_dispatch_workers_busy` serilerine birlikte bakmak
gerçek nedeni söyler.

## Halyard olayları şifreli mi saklıyor?

Hayır. Veritabanına erişen herkes, henüz temizlenmemiş bütün gövdelere ve uç noktaların özel
başlıklarına erişir. Birimi şifreleyin; Halyard bu konuda bir şey yaptığını iddia etmez.
