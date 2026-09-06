// Optional, unprivileged per-socket telemetry. fd 3 is a DUPLICATE of the
// diagnostic client's TCP/TLS socket. Never read/write application bytes.
// Build: cc -O2 tests/transport/tcp-info.c -o /tmp/arena-tcp-info
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>

int main(void) {
    setvbuf(stdout, NULL, _IOLBF, 0);
    // Stop when the parent closes stdin; never need a sandbox-restricted kill.
    struct pollfd stop = { .fd = STDIN_FILENO, .events = POLLIN | POLLHUP };
    for (int i = 0; i < 80000; ++i) {
#ifdef __APPLE__
        struct tcp_connection_info info;
        memset(&info, 0, sizeof(info));
        socklen_t length = sizeof(info);
        if (getsockopt(3, IPPROTO_TCP, TCP_CONNECTION_INFO, &info, &length)) {
            fprintf(stderr, "TCP_CONNECTION_INFO: %s\n", strerror(errno)); return 1;
        }
        printf("{\"txRetransmitPackets\":%llu,\"txRetransmitBytes\":%llu,\"rxOutOfOrderBytes\":%llu,\"rttMs\":%u,\"rtoMs\":%u,\"sendBufferBytes\":%u,\"lossRecovery\":%s}\n",
            (unsigned long long)info.tcpi_txretransmitpackets,
            (unsigned long long)info.tcpi_txretransmitbytes,
            (unsigned long long)info.tcpi_rxoutoforderbytes,
            info.tcpi_rttcur, info.tcpi_rto, info.tcpi_snd_sbbytes,
            info.tcpi_flags & TCPCI_FLAG_LOSSRECOVERY ? "true" : "false");
#elif defined(__linux__)
        struct tcp_info info;
        memset(&info, 0, sizeof(info));
        socklen_t length = sizeof(info);
        if (getsockopt(3, IPPROTO_TCP, TCP_INFO, &info, &length)) {
            fprintf(stderr, "TCP_INFO: %s\n", strerror(errno)); return 1;
        }
        // Portable Linux header fields. Do not invent receive-side counters
        // when this API/header does not expose them.
        printf("{\"txRetransmitPackets\":%u,\"txRetransmitBytes\":null,\"rxOutOfOrderBytes\":null,\"rttMs\":%.3f,\"rtoMs\":%.3f,\"sendBufferBytes\":null,\"lossRecovery\":null}\n",
            info.tcpi_total_retrans, info.tcpi_rtt / 1000.0, info.tcpi_rto / 1000.0);
#else
        fprintf(stderr, "TCP telemetry unsupported on this platform\n"); return 1;
#endif
        if (poll(&stop, 1, 50) != 0) break;
    }
    close(3);
    return 0;
}
